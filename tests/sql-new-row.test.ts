import { buildInlineInsertQuery } from "../src/formatters";

describe("buildInlineInsertQuery", () => {
    // Mock columns meta array: [cid, name, type, notnull, default_value, pk]
    const mockColumns = [
        [0, "id", "INTEGER", 0, null, 1], // PK
        [1, "name", "TEXT", 1, null, 0], // NOT NULL, no default
        [2, "age", "INTEGER", 0, null, 0], // Nullable
        [3, "status", "TEXT", 0, "'active'", 0], // Has default
    ];

    test("builds form-driven queries correctly", () => {
        const formData = { name: "Alexander", age: "23" };
        const { query, values } = buildInlineInsertQuery("users", mockColumns, "id", formData);

        expect(query).toBe('INSERT INTO "users" ("name", "age") VALUES (?, ?)');
        expect(values).toEqual(["Alexander", "23"]);
    });

    test("generates safe Quick Insert defaults (respecting schema)", () => {
        // Quick insert skips form data
        const { query, values } = buildInlineInsertQuery("users", mockColumns, "id");

        // Should skip 'id' (PK) and 'status' (has default).
        // 'name' is NOT NULL so it gets an empty string. 'age' gets null.
        expect(query).toBe('INSERT INTO "users" ("name", "age") VALUES (?, ?)');
        expect(values).toEqual(["", 0]);
    });

    test("handles DEFAULT VALUES edge case", () => {
        // A table where every single column is auto-handled by SQLite
        const autoColumns = [
            [0, "id", "INTEGER", 0, null, 1],
            [1, "created_at", "DATETIME", 0, "CURRENT_TIMESTAMP", 0],
        ];

        const { query, values } = buildInlineInsertQuery("logs", autoColumns, "id");

        expect(query).toBe('INSERT INTO "logs" DEFAULT VALUES');
        expect(values).toEqual([]);
    });
});
