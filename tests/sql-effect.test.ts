import { analyzeSqlEffect, stripSqlNoise } from "../src/formatters";

describe("stripSqlNoise", () => {
    test("blanks line and block comments", () => {
        expect(stripSqlNoise("SELECT 1; -- DELETE FROM t")).not.toMatch(/DELETE/);
        expect(stripSqlNoise("SELECT 1; /* DROP TABLE t */")).not.toMatch(/DROP/);
    });

    test("blanks string literals and quoted identifiers", () => {
        expect(stripSqlNoise("SELECT 'INSERT INTO x'")).not.toMatch(/INSERT/);
        expect(stripSqlNoise('SELECT * FROM "delete"')).not.toMatch(/delete/);
    });
});

describe("analyzeSqlEffect", () => {
    test("read-only queries never trigger a save", () => {
        expect(analyzeSqlEffect("SELECT * FROM users")).toEqual({ mutates: false, changesSchema: false });
        expect(analyzeSqlEffect("SELECT * FROM users LIMIT 10;")).toEqual({ mutates: false, changesSchema: false });
        expect(analyzeSqlEffect("PRAGMA table_info(users);")).toEqual({ mutates: false, changesSchema: false });
        expect(analyzeSqlEffect("")).toEqual({ mutates: false, changesSchema: false });
    });

    test("a table named like a keyword does not look like a write", () => {
        expect(analyzeSqlEffect('SELECT * FROM "delete"').mutates).toBe(false);
        expect(analyzeSqlEffect("SELECT 'DROP TABLE x' AS note").mutates).toBe(false);
        expect(analyzeSqlEffect("SELECT 1 -- INSERT INTO log VALUES (1)").mutates).toBe(false);
    });

    test("detects row writes", () => {
        expect(analyzeSqlEffect("INSERT INTO t (a) VALUES (1)").mutates).toBe(true);
        expect(analyzeSqlEffect("UPDATE t SET a = 1").mutates).toBe(true);
        expect(analyzeSqlEffect("DELETE FROM t WHERE id = 1").mutates).toBe(true);
        expect(analyzeSqlEffect("REPLACE INTO t VALUES (1)").mutates).toBe(true);
    });

    test("detects schema changes", () => {
        expect(analyzeSqlEffect("CREATE TABLE t (a TEXT);")).toEqual({ mutates: true, changesSchema: true });
        expect(analyzeSqlEffect('DROP VIEW "v";')).toEqual({ mutates: true, changesSchema: true });
        expect(analyzeSqlEffect("ALTER TABLE t RENAME TO t2;")).toEqual({ mutates: true, changesSchema: true });
    });

    test("classifies CTEs by what they feed", () => {
        expect(analyzeSqlEffect("WITH x AS (SELECT 1) SELECT * FROM x").mutates).toBe(false);
        expect(analyzeSqlEffect("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x").mutates).toBe(true);
    });

    test("treats PRAGMA as a write only when it assigns", () => {
        expect(analyzeSqlEffect("PRAGMA user_version;").mutates).toBe(false);
        expect(analyzeSqlEffect("PRAGMA user_version = 4;").mutates).toBe(true);
    });

    test("flags a batch if any statement writes", () => {
        expect(analyzeSqlEffect("SELECT * FROM t; DELETE FROM t WHERE id = 1;")).toEqual({
            mutates: true,
            changesSchema: false,
        });
    });
});
