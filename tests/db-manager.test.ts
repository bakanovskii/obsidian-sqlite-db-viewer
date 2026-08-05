import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import type { App, TFile } from "obsidian";
import { FakeVault } from "./mocks/fake-vault";

let SQL: SqlJsStatic;

// The real getSql() reads a WASM blob injected at build time, which does not exist here
jest.mock("../src/utils", () => {
    const actual = jest.requireActual<typeof import("../src/utils")>("../src/utils");
    return {
        ...actual,
        getSql: () => (globalThis as unknown as { __SQL__: SqlJsStatic }).__SQL__,
    };
});

import { DbManager, ExternalChangeError } from "../src/db-manager";

beforeAll(async () => {
    SQL = await initSqlJs({
        locateFile: (file: string) => `node_modules/sql.js/dist/${file}`,
    });
    (globalThis as unknown as { __SQL__: SqlJsStatic }).__SQL__ = SQL;
});

/** Builds a one-table database and returns its bytes. */
function seedDatabase(): Uint8Array {
    const db = new SQL.Database();
    db.exec(`CREATE TABLE log ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "note" TEXT);`);
    db.exec(`INSERT INTO log ("note") VALUES ('seed');`);
    const bytes = db.export();
    db.close();
    return bytes;
}

function readNotes(vault: FakeVault, file: TFile): string[] {
    const db = new SQL.Database(vault.files.get(file.path));
    const res = db.exec(`SELECT note FROM log ORDER BY id;`);
    const notes = res.length ? res[0].values.map((r) => String(r[0])) : [];
    db.close();
    return notes;
}

function setup(backups = false, backupFolder = "") {
    const vault = new FakeVault();
    // The fake file only implements the fields DbManager reads
    const file = vault.create("dbs/stats.db", seedDatabase()) as unknown as TFile;
    const app = { vault } as unknown as App;
    const manager = new DbManager(app, () => ({ enabled: backups, folder: backupFolder }));
    return { vault, file, manager };
}

describe("DbManager", () => {
    test("hands the same connection to every consumer of a file", async () => {
        const { file, manager } = setup();

        const a = await manager.acquire(file);
        const b = await manager.acquire(file);

        expect(a.db).toBe(b.db);

        a.release();
        b.release();
    });

    test("acquiring concurrently still yields one connection", async () => {
        const { file, manager } = setup();

        const [a, b] = await Promise.all([manager.acquire(file), manager.acquire(file)]);

        expect(a.db).toBe(b.db);

        a.release();
        b.release();
    });

    test("two tables editing one database do not overwrite each other", async () => {
        const { vault, file, manager } = setup();

        // Two embeds of the same database, opened at the same time
        const lengthCycle = await manager.acquire(file);
        const meatCycle = await manager.acquire(file);

        lengthCycle.db!.exec(`INSERT INTO log ("note") VALUES ('length');`);
        await lengthCycle.save();

        meatCycle.db!.exec(`INSERT INTO log ("note") VALUES ('meat');`);
        await meatCycle.save();

        // The second save must not roll the first one back
        expect(readNotes(vault, file)).toEqual(["seed", "length", "meat"]);

        lengthCycle.release();
        meatCycle.release();
    });

    test("AUTOINCREMENT keeps advancing across writers", async () => {
        const { vault, file, manager } = setup();

        const a = await manager.acquire(file);
        const b = await manager.acquire(file);

        a.db!.exec(`INSERT INTO log ("note") VALUES ('a');`);
        await a.save();
        b.db!.exec(`INSERT INTO log ("note") VALUES ('b');`);
        await b.save();

        const db = new SQL.Database(vault.files.get(file.path));
        const seq = db.exec(`SELECT seq FROM sqlite_sequence WHERE name = 'log';`);
        db.close();

        expect(Number(seq[0].values[0][0])).toBe(3);

        a.release();
        b.release();
    });

    test("notifies the other consumers, but not the writer", async () => {
        const { file, manager } = setup();

        const writer = await manager.acquire(file);
        const reader = await manager.acquire(file);

        const writerSeen: string[] = [];
        const readerSeen: string[] = [];
        writer.onChange((reason) => writerSeen.push(reason));
        reader.onChange((reason) => readerSeen.push(reason));

        writer.db!.exec(`INSERT INTO log ("note") VALUES ('x');`);
        await writer.save();

        expect(writerSeen).toEqual([]);
        expect(readerSeen).toEqual(["write"]);

        writer.release();
        reader.release();
    });

    test("refuses to overwrite a file changed on disk, and reloads instead", async () => {
        const { vault, file, manager } = setup();

        const handle = await manager.acquire(file);
        handle.db!.exec(`INSERT INTO log ("note") VALUES ('mine');`);

        // Sync writes a different version underneath us
        const other = new SQL.Database(seedDatabase());
        other.exec(`INSERT INTO log ("note") VALUES ('theirs');`);
        vault.writeExternally(file, other.export());
        other.close();

        await expect(handle.save()).rejects.toBeInstanceOf(ExternalChangeError);

        // Their write survived and we are now looking at it
        expect(readNotes(vault, file)).toEqual(["seed", "theirs"]);
        expect(readNotes(vault, file)).toEqual(
            handle.db!.exec(`SELECT note FROM log ORDER BY id;`)[0].values.map((r) => String(r[0]))
        );

        handle.release();
    });

    test("serializes concurrent saves", async () => {
        const { vault, file, manager } = setup();
        const handle = await manager.acquire(file);

        handle.db!.exec(`INSERT INTO log ("note") VALUES ('one');`);
        const first = handle.save();
        handle.db!.exec(`INSERT INTO log ("note") VALUES ('two');`);
        const second = handle.save();

        await Promise.all([first, second]);

        expect(vault.writeCount).toBe(2);
        expect(readNotes(vault, file)).toEqual(["seed", "one", "two"]);

        handle.release();
    });

    test("writes one rotating backup before the first write of a session", async () => {
        const { vault, file, manager } = setup(true);
        const handle = await manager.acquire(file);

        handle.db!.exec(`INSERT INTO log ("note") VALUES ('after');`);
        await handle.save();
        handle.db!.exec(`INSERT INTO log ("note") VALUES ('later');`);
        await handle.save();

        const backups = Array.from(vault.files.keys()).filter((p) => p.includes(".backup-"));

        // By default the copy sits next to the database itself
        expect(backups).toEqual(["dbs/stats.backup-1.db"]);

        // The backup holds the state from before this session's writes
        const backup = new SQL.Database(vault.files.get(backups[0]));
        const rows = backup.exec(`SELECT note FROM log ORDER BY id;`)[0].values.map((r) => String(r[0]));
        backup.close();
        expect(rows).toEqual(["seed"]);

        handle.release();
    });

    test("writes backups into the configured folder, mirroring the database's path", async () => {
        const { vault, file, manager } = setup(true, "Backups/db");
        const handle = await manager.acquire(file);

        handle.db!.exec(`INSERT INTO log ("note") VALUES ('after');`);
        await handle.save();

        expect(Array.from(vault.files.keys()).filter((p) => p.includes(".backup-"))).toEqual([
            "Backups/db/dbs/stats.backup-1.db",
        ]);

        handle.release();
    });

    test("does not back up a backup", async () => {
        const vault = new FakeVault();
        // A backup carries the database extension, so it can be opened and edited too
        const backup = vault.create("dbs/stats.backup-1.db", seedDatabase()) as unknown as TFile;
        const app = { vault } as unknown as App;
        const manager = new DbManager(app, () => ({ enabled: true, folder: "" }));

        const handle = await manager.acquire(backup);
        handle.db!.exec(`INSERT INTO log ("note") VALUES ('edited');`);
        await handle.save();

        expect(Array.from(vault.files.keys())).toEqual(["dbs/stats.backup-1.db"]);

        handle.release();
    });

    test("rotates backup slots across sessions", async () => {
        const vault = new FakeVault();
        const file = vault.create("dbs/stats.db", seedDatabase()) as unknown as TFile;
        const app = { vault } as unknown as App;
        const manager = new DbManager(app, () => ({ enabled: true, folder: "" }));

        for (const note of ["first", "second", "third"]) {
            // Each open/close cycle is one session, and takes one backup
            const handle = await manager.acquire(file);
            handle.db!.exec(`INSERT INTO log ("note") VALUES ('${note}');`);
            await handle.save();
            handle.release();
            await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        }

        const slots = Array.from(vault.files.keys())
            .filter((p) => p.includes(".backup-"))
            .sort();
        expect(slots).toEqual(["dbs/stats.backup-1.db", "dbs/stats.backup-2.db", "dbs/stats.backup-3.db"]);

        // Slot 1 is the newest state, slot 3 the oldest
        const notesIn = (path: string) => {
            const db = new SQL.Database(vault.files.get(path));
            const rows = db.exec(`SELECT note FROM log ORDER BY id;`)[0].values.map((r) => String(r[0]));
            db.close();
            return rows;
        };
        expect(notesIn("dbs/stats.backup-1.db")).toEqual(["seed", "first", "second"]);
        expect(notesIn("dbs/stats.backup-3.db")).toEqual(["seed"]);
    });

    test("keeps the connection alive until the last handle is released", async () => {
        const { file, manager } = setup();

        const a = await manager.acquire(file);
        const b = await manager.acquire(file);
        const db = a.db as Database;

        a.release();
        await Promise.resolve();
        expect(b.db).toBe(db);

        b.release();
        await Promise.resolve();
        await Promise.resolve();
        expect(b.db).toBeNull();
    });

    test("adopts an external change reported through the vault", async () => {
        const { vault, file, manager } = setup();
        const handle = await manager.acquire(file);

        const seen: string[] = [];
        handle.onChange((reason) => seen.push(reason));

        const other = new SQL.Database(seedDatabase());
        other.exec(`INSERT INTO log ("note") VALUES ('remote');`);
        vault.writeExternally(file, other.export());
        other.close();

        manager.handleModify(file);
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

        expect(seen).toEqual(["external"]);
        expect(handle.db!.exec(`SELECT note FROM log ORDER BY id;`)[0].values.map((r) => String(r[0]))).toEqual([
            "seed",
            "remote",
        ]);

        handle.release();
    });
});
