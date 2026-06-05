import { parseSqlCodeBlock } from "../src/formatters";

describe("parseSqlCodeBlock", () => {
    test("extracts standard db path and query", () => {
        const source = "db: my_database.db\nSELECT * FROM users;";
        const { dbPath, query } = parseSqlCodeBlock(source);

        expect(dbPath).toBe("my_database.db");
        expect(query).toBe("SELECT * FROM users;");
    });

    test("handles the optional 'query:' prefix", () => {
        const source = "db: test.sqlite\nquery: SELECT * FROM items LIMIT 5;";
        const { dbPath, query } = parseSqlCodeBlock(source);

        expect(dbPath).toBe("test.sqlite");
        expect(query).toBe("SELECT * FROM items LIMIT 5;");
    });

    test("handles multiline queries with trailing spaces", () => {
        const source = "db:   spaced.db  \nSELECT *\nFROM data\nWHERE id = 1;   ";
        const { dbPath, query } = parseSqlCodeBlock(source);

        expect(dbPath).toBe("spaced.db");
        expect(query).toBe("SELECT *\nFROM data\nWHERE id = 1;");
    });
});
