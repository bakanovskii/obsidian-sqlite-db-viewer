import { highlightSqlSyntax } from "../src/formatters";

describe("highlightSqlSyntax", () => {
    test("escapes HTML to prevent XSS in the terminal", () => {
        const result = highlightSqlSyntax("SELECT * FROM <script>alert(1)</script>");
        expect(result).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(result).not.toContain("<script>");
    });

    test("highlights SQL keywords case-insensitively", () => {
        const result = highlightSqlSyntax("select * from users");
        expect(result).toContain('<span style="color: #569cd6; font-weight: bold;">select</span>');
        expect(result).toContain('<span style="color: #569cd6; font-weight: bold;">from</span>');
    });

    test("highlights single-quote strings correctly", () => {
        const result = highlightSqlSyntax("INSERT INTO users VALUES ('John Doe')");
        expect(result).toContain("<span style=\"color: #ce9178;\">'John Doe'</span>");
    });

    test("highlights SQL comments correctly", () => {
        const result = highlightSqlSyntax("SELECT * FROM users -- gets all users");
        expect(result).toContain('<span style="color: #6a9955;">-- gets all users</span>');
    });
});
