import { buildBackupPath, isBackupPath } from "../src/formatters";

describe("buildBackupPath", () => {
    test("keeps the backup next to the database when no folder is set", () => {
        expect(buildBackupPath("dbs/stats.db", "", 1)).toBe("dbs/stats.backup-1.db");
        expect(buildBackupPath("dbs/stats.db", "", 3)).toBe("dbs/stats.backup-3.db");
    });

    test("handles a database in the vault root", () => {
        expect(buildBackupPath("stats.db", "", 1)).toBe("stats.backup-1.db");
        expect(buildBackupPath("stats.db", "Backups", 1)).toBe("Backups/stats.backup-1.db");
    });

    test("mirrors the database folder under the chosen backup folder", () => {
        expect(buildBackupPath("dbs/stats.db", "Backups", 1)).toBe("Backups/dbs/stats.backup-1.db");
        expect(buildBackupPath("a/b/c/stats.db", "Backups/db", 2)).toBe("Backups/db/a/b/c/stats.backup-2.db");
    });

    test("mirroring keeps same-named databases apart", () => {
        const first = buildBackupPath("projects/one/stats.db", "Backups", 1);
        const second = buildBackupPath("projects/two/stats.db", "Backups", 1);
        expect(first).not.toBe(second);
    });

    test("tolerates stray and duplicated separators", () => {
        expect(buildBackupPath("/dbs//stats.db", "/Backups/", 1)).toBe("Backups/dbs/stats.backup-1.db");
        expect(buildBackupPath("dbs/stats.db", "/", 1)).toBe("dbs/stats.backup-1.db");
    });

    test("keeps the database extension so Obsidian shows and opens the backup", () => {
        expect(buildBackupPath("dbs/my.notes.sqlite3", "", 1)).toBe("dbs/my.notes.backup-1.sqlite3");
        expect(buildBackupPath("dbs/stats.sqlite", "", 1)).toBe("dbs/stats.backup-1.sqlite");
        // A name with no extension still gets a usable slot name
        expect(buildBackupPath("dbs/stats", "", 1)).toBe("dbs/stats.backup-1");
    });
});

describe("isBackupPath", () => {
    test("recognises every slot of every supported extension", () => {
        for (let slot = 1; slot <= 3; slot++) {
            expect(isBackupPath(buildBackupPath("dbs/stats.db", "", slot))).toBe(true);
            expect(isBackupPath(buildBackupPath("dbs/stats.sqlite3", "Backups", slot))).toBe(true);
        }
    });

    test("leaves ordinary databases alone", () => {
        expect(isBackupPath("dbs/stats.db")).toBe(false);
        expect(isBackupPath("dbs/my.notes.sqlite3")).toBe(false);
        expect(isBackupPath("backup.db")).toBe(false);
        expect(isBackupPath("dbs/backups/stats.db")).toBe(false);
    });
});
