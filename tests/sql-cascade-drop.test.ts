import { generateCascadeQueries } from "../src/formatters";

describe("generateCascadeQueries", () => {
    const views = [
        { name: "active_users", sql: 'CREATE VIEW "active_users" AS SELECT * FROM "users" WHERE active = 1' },
        { name: "other_view", sql: 'CREATE VIEW "other_view" AS SELECT * FROM "data"' },
    ];

    test("cascades a RENAME action securely", () => {
        const query = generateCascadeQueries("RENAME", "users", views, "clients");

        expect(query).toContain('ALTER TABLE "users" RENAME TO "clients";');
        // It must drop and recreate the dependent view
        expect(query).toContain('DROP VIEW "active_users";');
        expect(query).toContain('SELECT * FROM "clients" WHERE active = 1');
        // It must NOT touch the unrelated view
        expect(query).not.toContain("other_view");
    });

    test("cascades a DROP action securely", () => {
        const query = generateCascadeQueries("DROP", "users", views);

        expect(query).toContain('DROP TABLE "users";');
        // It must drop the dependent view entirely
        expect(query).toContain('DROP VIEW "active_users";');
        // It must NOT touch the unrelated view
        expect(query).not.toContain("other_view");
    });

    test("modifies table prefixes correctly during rename", () => {
        const prefixViews = [{ name: "v1", sql: "SELECT users.id, users.name FROM users" }];
        const query = generateCascadeQueries("RENAME", "users", prefixViews, "clients");

        expect(query).toContain('SELECT "clients".id, "clients".name FROM "clients"');
    });
});
