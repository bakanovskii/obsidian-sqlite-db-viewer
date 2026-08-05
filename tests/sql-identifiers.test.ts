import { quoteIdent, quoteLiteral, escapeRegex, formatCellForEdit, parseCellInput } from "../src/formatters";

describe("quoteIdent", () => {
    test("wraps and doubles embedded quotes", () => {
        expect(quoteIdent("users")).toBe('"users"');
        expect(quoteIdent('we"ird')).toBe('"we""ird"');
        expect(quoteIdent("my table")).toBe('"my table"');
    });

    test("neutralises an injection attempt in a table name", () => {
        expect(quoteIdent('t"; DROP TABLE users; --')).toBe('"t""; DROP TABLE users; --"');
    });
});

describe("quoteLiteral", () => {
    test("wraps and doubles embedded apostrophes", () => {
        expect(quoteLiteral("abc")).toBe("'abc'");
        expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
        expect(quoteLiteral("' OR 1=1 --")).toBe("''' OR 1=1 --'");
    });
});

describe("escapeRegex", () => {
    test("escapes metacharacters so names cannot alter the pattern", () => {
        expect(escapeRegex("a.b")).toBe("a\\.b");
        expect(escapeRegex("t(1)+")).toBe("t\\(1\\)\\+");
        expect(new RegExp(escapeRegex("a.b")).test("axb")).toBe(false);
        expect(new RegExp(escapeRegex("a.b")).test("a.b")).toBe(true);
    });
});

describe("NULL round-tripping in editable cells", () => {
    test("a real NULL shows as NULL and parses back to null", () => {
        expect(formatCellForEdit(null)).toBe("NULL");
        expect(parseCellInput("NULL")).toBeNull();
    });

    test("the literal string NULL survives an untouched edit", () => {
        const stored = "NULL";
        const shown = formatCellForEdit(stored);
        expect(shown).toBe("\\NULL");
        expect(parseCellInput(shown)).toBe(stored);
    });

    test("escaped forms nest without collapsing", () => {
        expect(formatCellForEdit("\\NULL")).toBe("\\\\NULL");
        expect(parseCellInput("\\\\NULL")).toBe("\\NULL");
    });

    test("ordinary values are untouched", () => {
        expect(formatCellForEdit("hello")).toBe("hello");
        expect(formatCellForEdit(42)).toBe("42");
        expect(parseCellInput("hello")).toBe("hello");
        expect(parseCellInput("")).toBe("");
        expect(parseCellInput("NULLABLE")).toBe("NULLABLE");
    });
});
