import { App, Notice, TFile } from "obsidian";
import type { Database } from "sql.js";
import { getSql, toArrayBuffer } from "./utils";
import { buildBackupPath, isBackupPath } from "./formatters";

/** How many rotating safety copies are kept per database file. */
const BACKUP_SLOTS = 3;

/**
 * How long a connection is kept after its last consumer let go.
 *
 * Live preview unloads and rebuilds embeds constantly — every scroll, every edit —
 * so without a grace period each of those would re-read and re-parse the whole
 * database file, and start a fresh "session" that burns a rotating backup slot.
 */
const IDLE_CLOSE_MS = 30_000;

/**
 * Obsidian may update `TFile.stat` slightly after `modifyBinary` resolves, so a
 * "modify" event arriving right after our own write can look like a foreign one.
 */
const SELF_WRITE_GRACE_MS = 1500;

export type DbChangeReason = "external" | "write";
export type DbChangeListener = (reason: DbChangeReason) => void;

export interface BackupConfig {
    enabled: boolean;
    /** Vault-relative folder for backups; empty means "next to the database". */
    folder: string;
}

interface DbEntry {
    path: string;
    db: Database;
    closed: boolean;
    refCount: number;
    /** mtime of the file as we last saw it. Anything newer on disk is somebody else's write. */
    knownMtime: number;
    /** Serializes exports so two writes can never interleave into one file. */
    writeChain: Promise<unknown>;
    /** Our own writes are echoed back as "modify" events; ignore them until this moment. */
    selfWriteUntil: number;
    /** A rotating backup is taken once per entry lifetime, before the first write. */
    backupTaken: boolean;
    /** Pending idle shutdown, cancelled as soon as somebody checks the entry out again. */
    closeTimer: number | null;
    listeners: Set<DbChangeListener>;
}

export class ExternalChangeError extends Error {
    constructor(path: string) {
        super(`"${path}" changed on disk. It was reloaded and the last edit was NOT saved, to avoid overwriting it.`);
        this.name = "ExternalChangeError";
    }
}

/**
 * Owns exactly one in-memory `Database` per database file, shared by every view,
 * embed and code block that points at it.
 *
 * Writing a sql.js database means exporting the *whole* file, so two independent
 * copies of the same file will silently overwrite each other's changes. Keeping a
 * single connection per path — plus an mtime guard for changes made outside the
 * plugin — is what makes concurrent editing safe.
 */
export class DbManager {
    private entries = new Map<string, DbEntry>();
    private loading = new Map<string, Promise<DbEntry>>();

    constructor(
        private app: App,
        private backupConfig: () => BackupConfig,
        private idleCloseMs: number = IDLE_CLOSE_MS
    ) {}

    /** Checks out the shared connection for `file`. Every handle must be released. */
    async acquire(file: TFile): Promise<DbHandle> {
        // Reading the file is asynchronous, so the entry we waited for may have been
        // dropped in the meantime. Nothing may await between the check below and the
        // check-in, or the connection could be closed out from under this handle.
        for (let attempt = 0; attempt < 3; attempt++) {
            const entry = await this.getEntry(file);
            if (entry.closed || this.entries.get(entry.path) !== entry) continue;

            this.cancelClose(entry);
            entry.refCount++;
            return new DbHandle(this, file, entry);
        }
        throw new Error(`Could not check out a connection for "${file.path}"`);
    }

    private async getEntry(file: TFile): Promise<DbEntry> {
        const existing = this.entries.get(file.path);
        if (existing && !existing.closed) return existing;

        let pending = this.loading.get(file.path);
        if (!pending) {
            pending = this.openEntry(file);
            this.loading.set(file.path, pending);
            void pending.catch(() => undefined).then(() => this.loading.delete(file.path));
        }
        return pending;
    }

    private async openEntry(file: TFile): Promise<DbEntry> {
        const db = await this.read(file);
        const entry: DbEntry = {
            path: file.path,
            db,
            closed: false,
            refCount: 0,
            knownMtime: file.stat.mtime,
            writeChain: Promise.resolve(),
            selfWriteUntil: 0,
            backupTaken: false,
            closeTimer: null,
            listeners: new Set(),
        };
        this.entries.set(file.path, entry);
        return entry;
    }

    private async read(file: TFile): Promise<Database> {
        const SQL = await getSql();
        const buffer = await this.app.vault.readBinary(file);
        return new SQL.Database(new Uint8Array(buffer));
    }

    /**
     * Queues a full export of the shared database behind any write already in flight.
     * `origin` is not notified, so the caller does not re-render on its own change.
     */
    save(file: TFile, origin: DbChangeListener | null = null): Promise<void> {
        const entry = this.entries.get(file.path);
        if (!entry || entry.closed) return Promise.resolve();

        const write = () => this.write(entry, file, origin);
        const run = entry.writeChain.then(write, write);

        // Keep the chain usable after a failed write without leaving it unhandled
        entry.writeChain = run.catch(() => undefined);
        return run;
    }

    private async write(entry: DbEntry, file: TFile, origin: DbChangeListener | null): Promise<void> {
        if (entry.closed || this.entries.get(entry.path) !== entry) return;

        // Never overwrite a file that somebody else changed since we last read it
        if (file.stat.mtime > entry.knownMtime && Date.now() > entry.selfWriteUntil) {
            await this.reload(entry, file);
            this.notify(entry, "external", null);
            throw new ExternalChangeError(entry.path);
        }

        // A backup carries the database's own extension, so it can be opened and edited
        // like any other database; it must not spawn backups of its own
        const backups = this.backupConfig();
        if (!entry.backupTaken && backups.enabled && !isBackupPath(file.path)) {
            entry.backupTaken = true;
            await this.writeBackup(file, backups.folder);
        }

        // Claim the write window *before* the file is touched: Obsidian reports the
        // modification while `modifyBinary` is still in flight, and a write taken for a
        // foreign one reloads the database and throws every open table back to page one
        entry.selfWriteUntil = Date.now() + SELF_WRITE_GRACE_MS;

        await this.app.vault.modifyBinary(file, toArrayBuffer(entry.db.export()));

        entry.knownMtime = Math.max(entry.knownMtime, file.stat.mtime);
        entry.selfWriteUntil = Date.now() + SELF_WRITE_GRACE_MS;

        this.notify(entry, "write", origin);
    }

    /**
     * Re-reads the file from disk and tells every other consumer to re-render.
     * `origin` is skipped so the caller can handle its own refresh in one pass.
     */
    async refresh(file: TFile, origin: DbChangeListener | null = null): Promise<void> {
        const entry = this.entries.get(file.path);
        if (!entry || entry.closed) return;
        await this.reload(entry, file);
        this.notify(entry, "external", origin);
    }

    private async reload(entry: DbEntry, file: TFile): Promise<void> {
        const fresh = await this.read(file);
        entry.db.close();
        entry.db = fresh;
        entry.knownMtime = file.stat.mtime;
    }

    private notify(entry: DbEntry, reason: DbChangeReason, origin: DbChangeListener | null) {
        entry.listeners.forEach((listener) => {
            if (listener === origin) return;
            try {
                listener(reason);
            } catch (e) {
                console.error("SQLite: change listener failed", e);
            }
        });
    }

    /** Vault "modify" hook: adopts changes written by Sync, another device or an external tool. */
    handleModify(file: TFile) {
        const entry = this.entries.get(file.path);
        if (!entry || entry.closed) return;
        if (file.stat.mtime <= entry.knownMtime) return;

        // Our own write whose stat update arrived late
        if (Date.now() <= entry.selfWriteUntil) {
            entry.knownMtime = file.stat.mtime;
            return;
        }

        void entry.writeChain
            .catch(() => undefined)
            .then(async () => {
                if (entry.closed) return;
                await this.reload(entry, file);
                this.notify(entry, "external", null);
            })
            .catch((e) => new Notice(`SQLite reload error: ${String(e)}`));
    }

    handleRename(file: TFile, oldPath: string) {
        const entry = this.entries.get(oldPath);
        if (!entry) return;
        this.entries.delete(oldPath);
        entry.path = file.path;
        this.entries.set(file.path, entry);
    }

    handleDelete(path: string) {
        const entry = this.entries.get(path);
        if (!entry) return;
        this.entries.delete(path);
        entry.listeners.clear();
        this.closeEntry(entry);
    }

    release(entry: DbEntry, listener: DbChangeListener | null) {
        if (listener) entry.listeners.delete(listener);
        entry.refCount--;
        if (entry.refCount > 0) return;
        this.scheduleClose(entry);
    }

    /** Drops an unused connection, but only after it has stayed unused for a while. */
    private scheduleClose(entry: DbEntry) {
        this.cancelClose(entry);

        // The main window, not activeWindow: connections outlive any popout, and a
        // popout closing must not strand a database that is still open
        entry.closeTimer = window.setTimeout(() => {
            entry.closeTimer = null;

            // Flush anything still queued before dropping the connection
            void entry.writeChain
                .catch(() => undefined)
                .then(() => {
                    // Somebody checked the entry out again while the queue drained
                    if (entry.refCount > 0 || entry.closed || entry.closeTimer) return;
                    if (this.entries.get(entry.path) === entry) this.entries.delete(entry.path);
                    this.closeEntry(entry);
                });
        }, this.idleCloseMs);
    }

    private cancelClose(entry: DbEntry) {
        if (entry.closeTimer === null) return;
        window.clearTimeout(entry.closeTimer);
        entry.closeTimer = null;
    }

    private closeEntry(entry: DbEntry) {
        if (entry.closed) return;
        this.cancelClose(entry);
        entry.closed = true;
        try {
            entry.db.close();
        } catch (e) {
            console.error("SQLite: failed to close database", e);
        }
    }

    /** Flushes and closes every connection. Called when the plugin unloads. */
    dispose() {
        const entries = Array.from(this.entries.values());
        this.entries.clear();
        this.loading.clear();
        entries.forEach((entry) => {
            // Nothing may outlive the plugin, so idle shutdowns go now rather than
            // whenever the queued writes happen to finish draining
            this.cancelClose(entry);
            entry.listeners.clear();
            void entry.writeChain.catch(() => undefined).then(() => this.closeEntry(entry));
        });
    }

    /** Creates a folder and any missing parents. */
    private async ensureFolder(folder: string) {
        if (!folder) return;
        const adapter = this.app.vault.adapter;

        let current = "";
        for (const segment of folder.split("/").filter(Boolean)) {
            current = current ? `${current}/${segment}` : segment;
            if (!(await adapter.exists(current))) await adapter.mkdir(current);
        }
    }

    /**
     * Rotates `<file>.1.bak` … `<file>.3.bak` and stores the current on-disk bytes as
     * slot 1, before this session's first write touches the file.
     *
     * This runs once per open database, not per edit: slot 1 is "how the file looked
     * before it was touched this session", and the older slots are previous sessions.
     */
    private async writeBackup(file: TFile, folder: string) {
        try {
            const adapter = this.app.vault.adapter;
            const slotPath = (slot: number) => buildBackupPath(file.path, folder, slot);

            const target = slotPath(1);
            await this.ensureFolder(target.split("/").slice(0, -1).join("/"));

            const oldest = slotPath(BACKUP_SLOTS);
            if (await adapter.exists(oldest)) await adapter.remove(oldest);
            for (let slot = BACKUP_SLOTS - 1; slot >= 1; slot--) {
                const from = slotPath(slot);
                if (await adapter.exists(from)) await adapter.rename(from, slotPath(slot + 1));
            }

            await adapter.writeBinary(target, await this.app.vault.readBinary(file));
        } catch (e) {
            new Notice(`SQLite: safety backup failed (${String(e)})`);
        }
    }
}

/** A reference to the shared connection for one file, owned by a single view or renderer. */
export class DbHandle {
    private listener: DbChangeListener | null = null;
    private released = false;

    constructor(
        private manager: DbManager,
        readonly file: TFile,
        private entry: DbEntry
    ) {}

    get db(): Database | null {
        if (this.released || this.entry.closed) return null;
        return this.entry.db;
    }

    /** Registers a callback fired whenever anybody else changes this database. */
    onChange(callback: DbChangeListener) {
        if (this.listener) this.entry.listeners.delete(this.listener);
        this.listener = callback;
        this.entry.listeners.add(callback);
    }

    save(): Promise<void> {
        if (this.released) return Promise.resolve();
        return this.manager.save(this.file, this.listener);
    }

    reload(): Promise<void> {
        if (this.released) return Promise.resolve();
        return this.manager.refresh(this.file, this.listener);
    }

    release() {
        if (this.released) return;
        this.released = true;
        this.manager.release(this.entry, this.listener);
        this.listener = null;
    }
}
