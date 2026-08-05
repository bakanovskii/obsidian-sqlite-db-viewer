import { TFile } from "./obsidian";

/**
 * In-memory vault + adapter, enough for DbManager: binary read/write with an
 * mtime that advances on every write, and the handful of adapter calls used
 * by the rotating backups.
 */
export class FakeVault {
    configDir = ".obsidian";
    files = new Map<string, Uint8Array>();
    writeCount = 0;

    /**
     * Called while a write is still in flight. Obsidian echoes its own "modify" event
     * back at that point, which is exactly when a write is easiest to mistake for a
     * foreign one.
     */
    onModify: ((file: TFile) => void) | null = null;

    private clock = 1000;

    adapter = {
        exists: async (path: string) => this.files.has(path),
        mkdir: async () => undefined,
        remove: async (path: string) => {
            this.files.delete(path);
        },
        rename: async (from: string, to: string) => {
            const data = this.files.get(from);
            if (data) {
                this.files.set(to, data);
                this.files.delete(from);
            }
        },
        writeBinary: async (path: string, data: ArrayBuffer) => {
            this.files.set(path, new Uint8Array(data));
        },
        readBinary: async (path: string) => this.toArrayBuffer(this.files.get(path)!),
    };

    create(path: string, data: Uint8Array): TFile {
        const file = new TFile(path);
        this.files.set(path, data);
        file.stat.mtime = ++this.clock;
        file.stat.size = data.byteLength;
        return file;
    }

    async readBinary(file: TFile): Promise<ArrayBuffer> {
        const data = this.files.get(file.path);
        if (!data) throw new Error(`No such file: ${file.path}`);
        return this.toArrayBuffer(data);
    }

    async modifyBinary(file: TFile, buffer: ArrayBuffer): Promise<void> {
        this.writeCount++;
        this.files.set(file.path, new Uint8Array(buffer));
        file.stat.mtime = ++this.clock;
        file.stat.size = buffer.byteLength;
        this.onModify?.(file);
    }

    /** Simulates Obsidian Sync or an external tool rewriting the file. */
    writeExternally(file: TFile, data: Uint8Array) {
        this.files.set(file.path, data);
        file.stat.mtime = ++this.clock;
        file.stat.size = data.byteLength;
    }

    private toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    }
}
