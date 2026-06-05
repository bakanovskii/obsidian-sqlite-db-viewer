import { buildCreateTableSql } from "../src/formatters";

describe("SQL Generator", () => {
    test("builds a standard table with an auto-increment primary key", () => {
        const cols = [
            { name: "id", type: "INTEGER", isPk: true },
            { name: "username", type: "TEXT", isPk: false },
        ];
        const sql = buildCreateTableSql("users", cols);

        expect(sql).toContain('CREATE TABLE "users"');
        expect(sql).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
        expect(sql).toContain('"username" TEXT');
    });

    test("safely escapes malicious table and column names", () => {
        const cols = [{ name: 'bad"name', type: "TEXT", isPk: false }];
        const sql = buildCreateTableSql('evil"table', cols);

        expect(sql).toContain('CREATE TABLE "evil""table"');
        expect(sql).toContain('"bad""name" TEXT');
    });
});
