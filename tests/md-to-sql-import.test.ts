import { generateImportSql } from "../src/formatters";

describe("generateImportSql", () => {
    test("generates standard import queries without a primary key", () => {
        const { createTableSql, insertSql } = generateImportSql("users", ["name", "age"], false);

        expect(createTableSql).toBe('CREATE TABLE IF NOT EXISTS "users" ("name" TEXT, "age" TEXT);');
        expect(insertSql).toBe('INSERT INTO "users" ("name", "age") VALUES (?, ?);');
    });

    test("adds auto-incrementing primary key when requested", () => {
        const { createTableSql, insertSql } = generateImportSql("users", ["name", "age"], true);

        expect(createTableSql).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
        // Ensures the INSERT statement explicitly names columns so it skips the new ID column
        expect(insertSql).toBe('INSERT INTO "users" ("name", "age") VALUES (?, ?);');
    });

    test("resolves primary key name collisions automatically", () => {
        // The table already has an "id" column!
        const { createTableSql } = generateImportSql("users", ["id", "name"], true);

        expect(createTableSql).toContain('"id_1" INTEGER PRIMARY KEY AUTOINCREMENT');
        expect(createTableSql).toContain('"id" TEXT');
    });

    test("escapes malicious table and header names", () => {
        const { createTableSql, insertSql } = generateImportSql('bad"table', ['bad"col'], false);

        expect(createTableSql).toContain('"bad""table"');
        expect(createTableSql).toContain('"bad""col" TEXT');
        expect(insertSql).toContain('"bad""col"');
    });
});
