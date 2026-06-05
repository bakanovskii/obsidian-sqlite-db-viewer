import { buildCountQuery, buildPaginatedQuery } from "../src/formatters";

describe("Server-Side Query Builders", () => {
    describe("buildCountQuery", () => {
        test("wraps a basic SELECT query safely", () => {
            expect(buildCountQuery("SELECT * FROM users")).toBe("SELECT COUNT(*) FROM (SELECT * FROM users);");
        });

        test("handles trailing semicolons", () => {
            expect(buildCountQuery("SELECT id FROM data;")).toBe("SELECT COUNT(*) FROM (SELECT id FROM data);");
        });

        test("ignores non-SELECT queries to prevent destructive counts", () => {
            expect(buildCountQuery("UPDATE users SET name='test'")).toBe("");
            expect(buildCountQuery("PRAGMA table_info('users')")).toBe("");
            expect(buildCountQuery("DELETE FROM users")).toBe("");
        });
    });

    describe("buildPaginatedQuery", () => {
        test("wraps query with limit and offset", () => {
            expect(buildPaginatedQuery("SELECT * FROM users", undefined, null, 10, 20)).toBe(
                "SELECT * FROM (SELECT * FROM users) LIMIT 10 OFFSET 20;"
            );
        });

        test("applies sorting safely", () => {
            expect(buildPaginatedQuery("SELECT * FROM users", "name", "DESC", 50, 0)).toBe(
                'SELECT * FROM (SELECT * FROM users) ORDER BY "name" DESC LIMIT 50;'
            );
        });

        test("ignores limits and sorting on non-SELECT queries", () => {
            expect(buildPaginatedQuery("PRAGMA table_info('users');", "name", "ASC", 10, 0)).toBe(
                "PRAGMA table_info('users');"
            ); // returns base query untouched
        });

        test("escapes malicious column names in ORDER BY to prevent SQL injection", () => {
            expect(buildPaginatedQuery("SELECT * FROM users", 'bad"col', "ASC", 10, 0)).toBe(
                'SELECT * FROM (SELECT * FROM users) ORDER BY "bad""col" ASC LIMIT 10;'
            );
        });

        test("handles 'Show All' limits correctly (LIMIT without OFFSET)", () => {
            // If limit is somehow requested as massive but offset is 0, we drop offset
            expect(buildPaginatedQuery("SELECT * FROM users", undefined, null, 50, 0)).toBe(
                "SELECT * FROM (SELECT * FROM users) LIMIT 50;"
            );
        });
    });
});
