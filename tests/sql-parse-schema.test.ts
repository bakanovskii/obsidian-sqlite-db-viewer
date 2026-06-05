import { parseTableSchema } from "../src/formatters";

describe("parseTableSchema", () => {
    test("correctly parses raw PRAGMA table_info results", () => {
        // [cid, name, type, notnull, dflt_value, pk]
        const raw = [
            [0, "id", "INTEGER", 0, null, 1],
            [1, "email", "TEXT", 1, null, 0],
        ];
        const { columns, pkColumnName, hasPk } = parseTableSchema(raw);

        expect(columns.length).toBe(2);
        expect(pkColumnName).toBe("id");
        expect(hasPk).toBe(true);
        expect(columns[1].notNull).toBe(true);
    });

    test("handles tables without a primary key", () => {
        const raw = [[0, "data", "TEXT", 0, null, 0]];
        const { pkColumnName, hasPk } = parseTableSchema(raw);

        expect(pkColumnName).toBeNull();
        expect(hasPk).toBe(false);
    });
});
