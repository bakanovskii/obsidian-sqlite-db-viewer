import { stripMarkdown, extractTableNameFromQuery } from "../src/formatters";

describe("stripMarkdown", () => {
    test("removes standard markdown links", () => {
        expect(stripMarkdown("[OpenAI](https://openai.com)")).toBe("OpenAI");
    });

    test("removes Obsidian wikilinks", () => {
        expect(stripMarkdown("[[My Note]]")).toBe("My Note");
        expect(stripMarkdown("[[My Note|Custom Alias]]")).toBe("Custom Alias");
    });

    test("removes bold and italic syntax", () => {
        expect(stripMarkdown("**Bold Text**")).toBe("Bold Text");
        expect(stripMarkdown("__Bold Text__")).toBe("Bold Text");
        expect(stripMarkdown("*Italic* and _Italic_")).toBe("Italic and Italic");
    });

    test("removes highlights and inline code", () => {
        expect(stripMarkdown("==highlighted==")).toBe("highlighted");
        expect(stripMarkdown("`SELECT * FROM users`")).toBe("SELECT * FROM users");
    });

    test("handles empty strings", () => {
        expect(stripMarkdown("")).toBe("");
        expect(stripMarkdown(null as unknown as string)).toBe("");
    });
});

describe("extractTableNameFromQuery", () => {
    test("extracts standard table names", () => {
        expect(extractTableNameFromQuery("SELECT * FROM users")).toBe("users");
    });

    test("handles quotes, backticks, and brackets", () => {
        expect(extractTableNameFromQuery('SELECT * FROM "user_data" LIMIT 10')).toBe("user_data");
        expect(extractTableNameFromQuery("SELECT * FROM `items`")).toBe("items");
        expect(extractTableNameFromQuery("SELECT * FROM [old format]")).toBe("old format");
    });

    test("is case insensitive", () => {
        expect(extractTableNameFromQuery("select id from MY_TABLE where id = 1")).toBe("MY_TABLE");
    });

    test("returns null gracefully if no FROM clause exists", () => {
        expect(extractTableNameFromQuery("SELECT sqlite_version()")).toBeNull();
    });
});
