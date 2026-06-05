import { parseMarkdownTableRow, scanForMarkdownTable } from "../src/formatters";

describe("parseMarkdownTableRow", () => {
    test("parses a standard markdown table row", () => {
        const row = "| ID | Name | Age |";
        const cells = parseMarkdownTableRow(row);
        expect(cells).toEqual(["ID", "Name", "Age"]);
    });

    test("handles rows missing the outer markdown pipes", () => {
        const row = "ID | Name | Age";
        const cells = parseMarkdownTableRow(row);
        expect(cells).toEqual(["ID", "Name", "Age"]);
    });

    test("correctly parses escaped pipes without splitting", () => {
        const row = "| ID | Name \\| Alias | Age |";
        const cells = parseMarkdownTableRow(row);
        expect(cells).toEqual(["ID", "Name | Alias", "Age"]);
    });

    test("aggressively trims whitespace from cells", () => {
        const row = "|    Spaced    |   Out   |";
        const cells = parseMarkdownTableRow(row);
        expect(cells).toEqual(["Spaced", "Out"]);
    });
});

describe("scanForMarkdownTable", () => {
    const doc = ["Some text", "", "| ID | Name |", "|---|---|", "| 1 | Alice |", "| 2 | Bob |", "", "More text"];
    const getLine = (i: number) => doc[i];

    test("extracts perfectly when cursor is exactly on the table", () => {
        // Cursor on "| 1 | Alice |" (line 4)
        const lines = scanForMarkdownTable(doc.length, getLine, 4, 4, false);
        expect(lines.length).toBe(4);
        expect(lines[0]).toContain("ID");
        expect(lines[3]).toContain("Bob");
    });

    test("magnetically snaps to table if cursor is 2 lines above it", () => {
        // Cursor on "Some text" (line 0)
        const lines = scanForMarkdownTable(doc.length, getLine, 0, 0, false);
        expect(lines.length).toBe(4);
    });

    test("returns empty array if no table is near", () => {
        // Extend doc to make sure line 10 is way too far away
        const longDoc = [...doc, "", "", "Far away"];
        const getLongLine = (i: number) => longDoc[i];

        // Cursor on line 10 ("Far away")
        const lines = scanForMarkdownTable(longDoc.length, getLongLine, 10, 10, false);
        expect(lines.length).toBe(0);
    });
});
