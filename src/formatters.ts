import type { Database, SqlValue } from "sql.js";

/**
 * Strips markdown syntax from a string before inserting it into a database.
 */
export function stripMarkdown(text: string): string {
    if (!text) return "";
    return text
        .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1") // Obsidian Links
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Standard MD Links
        .replace(/(\*\*|__)(.*?)\1/g, "$2") // Bold
        .replace(/(\*|_)(.*?)\1/g, "$2") // Italic
        .replace(/~~(.*?)~~/g, "$1") // Strikethrough
        .replace(/==(.*?)==/g, "$1") // Highlights
        .replace(/`([^`]+)`/g, "$1") // Inline Code
        .replace(/\\(.)/g, "$1") // Escaped chars
        .trim();
}

/**
 * Returns the exact class list for the inner Table based on the user's Theme setting.
 */
export function getTableThemeClass(style: string): string {
    switch (style) {
        case "premium":
            return "sqlite-theme-premium-table";
        case "default":
        default:
            return "sqlite-theme-default-table";
    }
}

/**
 * Returns the exact class list for the outer Wrapper based on the user's Theme setting.
 */
export function getWrapperThemeClass(style: string): string {
    switch (style) {
        case "premium":
            return "sqlite-theme-premium-wrapper";
        case "default":
        default:
            return "";
    }
}

/**
 * Created SQL string to create new tables
 */
export function buildCreateTableSql(
    tableName: string,
    columns: { name: string; type: string; isPk: boolean }[]
): string {
    const defs = columns
        .map((c) => {
            const safeColName = c.name.replace(/"/g, '""');
            let def = `"${safeColName}" `;

            if (c.type === "DATETIME (Auto)") {
                def += "DATETIME DEFAULT CURRENT_TIMESTAMP";
            } else {
                def += c.type;
            }

            if (c.isPk) {
                def += " PRIMARY KEY";
                if (c.type === "INTEGER") def += " AUTOINCREMENT";
            }
            return def;
        })
        .join(",\n    ");

    const safeTableName = tableName.replace(/"/g, '""');
    return `CREATE TABLE "${safeTableName}" (\n    ${defs}\n);`;
}

/**
 * Safely parses a Markdown table row into an array of strings,
 * respecting escaped pipes (\|) and trimming whitespace.
 */
export function parseMarkdownTableRow(row: string): string[] {
    const cells: string[] = [];
    let currentCell = "";

    for (let i = 0; i < row.length; i++) {
        if (row[i] === "\\" && row[i + 1] === "|") {
            currentCell += "|";
            i++; // Skip the escaped pipe
        } else if (row[i] === "|") {
            cells.push(currentCell.trim());
            currentCell = "";
        } else {
            currentCell += row[i];
        }
    }
    cells.push(currentCell.trim());

    // Filter out the empty elements caused by standard outer markdown table pipes (e.g., | Cell | Cell |)
    return cells.filter((s, i, arr) => !(i === 0 && s === "") && !(i === arr.length - 1 && s === ""));
}

/**
 * Generates safe CREATE TABLE and INSERT statements for imported data,
 * handling SQL escaping and Primary Key collisions.
 */
export function generateImportSql(tableName: string, headers: string[], addPrimaryKey: boolean) {
    const safeTableName = `"${tableName.replace(/"/g, '""')}"`;
    const safeHeaders = headers.map((h) => `"${h.replace(/"/g, '""')}" TEXT`);

    // Explicitly name the columns being inserted so the auto-increment ID is safely skipped
    const insertCols = headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(", ");
    const placeholders = headers.map(() => "?").join(", ");

    if (addPrimaryKey) {
        let pkName = "id";
        let counter = 1;
        // Resolve collision if the imported table already has an "id" column
        const lowerHeaders = headers.map((h) => h.toLowerCase());
        while (lowerHeaders.includes(pkName)) {
            pkName = `id_${counter}`;
            counter++;
        }
        safeHeaders.unshift(`"${pkName}" INTEGER PRIMARY KEY AUTOINCREMENT`);
    }

    const createTableSql = `CREATE TABLE IF NOT EXISTS ${safeTableName} (${safeHeaders.join(", ")});`;
    const insertSql = `INSERT INTO ${safeTableName} (${insertCols}) VALUES (${placeholders});`;

    return { createTableSql, insertSql };
}

/**
 * Safely wraps a SELECT query to get the total row count without loading data.
 */
export function buildCountQuery(baseQuery: string): string {
    const query = baseQuery.trim().replace(/;$/, "");
    if (!query.toUpperCase().startsWith("SELECT")) return "";
    return `SELECT COUNT(*) FROM (${query});`;
}

/**
 * Wraps a base query with ORDER BY, LIMIT, and OFFSET for server-side pagination.
 */
export function buildPaginatedQuery(
    baseQuery: string,
    sortCol?: string,
    sortDir?: "ASC" | "DESC" | null,
    limit?: number,
    offset?: number
): string {
    const query = baseQuery.trim().replace(/;$/, "");
    if (!query.toUpperCase().startsWith("SELECT")) return baseQuery;

    let wrapper = `SELECT * FROM (${query})`;

    if (sortCol && sortDir) {
        wrapper += ` ORDER BY "${sortCol.replace(/"/g, '""')}" ${sortDir}`;
    }

    if (limit !== undefined && limit > 0) {
        wrapper += ` LIMIT ${limit}`;
        if (offset !== undefined && offset > 0) {
            wrapper += ` OFFSET ${offset}`;
        }
    }
    return wrapper + ";";
}
/**
 * Parses an Obsidian code block string to extract the database path and SQL query.
 */
export function parseSqlCodeBlock(source: string): { dbPath: string; query: string } {
    const lines = source.split("\n");
    let dbPath = "";
    const queryLines: string[] = [];

    for (const line of lines) {
        if (line.trim().startsWith("db:")) {
            dbPath = line.substring(3).trim();
        } else {
            queryLines.push(line);
        }
    }

    let query = queryLines.join("\n").trim();
    if (query.startsWith("query:")) {
        query = query.substring(6).trim();
    }

    return { dbPath, query };
}

/**
 * Calculates all necessary pagination constraints safely, ensuring pages never go out of bounds.
 */
export function calculatePagination(rawLimit: number, totalRows: number, requestedPage: number) {
    const actualLimit = rawLimit === 0 ? Math.max(totalRows, 1) : rawLimit;
    const totalPages = Math.ceil(totalRows / actualLimit) || 1;

    // Ensure the requested page stays within mathematically valid bounds
    let validPage = requestedPage;
    if (validPage < 0) validPage = 0;
    if (validPage >= totalPages) validPage = totalPages - 1;

    const startIndex = validPage * actualLimit;
    const endIndex = Math.min(startIndex + actualLimit, totalRows);

    return { actualLimit, totalPages, startIndex, endIndex, validPage };
}

/**
 * Applies basic syntax highlighting to a raw SQL string.
 * Escapes HTML to prevent XSS, and wraps strings, comments, and keywords in spans.
 */
export function highlightSqlSyntax(text: string): string {
    if (!text) {
        return '<span style="color:var(--text-faint);">-- SQL Terminal\n-- Enter query (Ctrl+Enter to execute)...\n-- Multiline and Tabs are supported.</span>';
    }

    // 1. Escape HTML to prevent accidental injection
    let escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // 2. Highlight Strings (Single quotes)
    escaped = escaped.replace(/('[^']*')/g, '<span style="color: #ce9178;">$1</span>');

    // 3. Highlight Comments (-- comment)
    escaped = escaped.replace(/(--.*)/g, '<span style="color: #6a9955;">$1</span>');

    // 4. Highlight SQL Keywords
    const keywords = [
        "SELECT",
        "FROM",
        "WHERE",
        "INSERT",
        "INTO",
        "VALUES",
        "UPDATE",
        "SET",
        "DELETE",
        "CREATE",
        "TABLE",
        "VIEW",
        "DROP",
        "ALTER",
        "LIMIT",
        "ORDER BY",
        "GROUP BY",
        "AND",
        "OR",
        "AS",
        "ON",
        "JOIN",
        "INNER",
        "LEFT",
        "RIGHT",
        "PRAGMA",
        "PRIMARY",
        "KEY",
        "AUTOINCREMENT",
        "NOT",
        "NULL",
        "DEFAULT",
    ];
    const regex = new RegExp(`\\b(${keywords.join("|")})\\b`, "gi");
    escaped = escaped.replace(regex, '<span style="color: #569cd6; font-weight: bold;">$1</span>');

    if (escaped.endsWith("\n")) escaped += " ";
    return escaped;
}

/**
 * Generates safely cascading SQL queries.
 * If a table is dropped or renamed, it finds all dependent Views and automatically drops/updates them.
 */
export function generateCascadeQueries(
    action: "RENAME" | "DROP",
    tableName: string,
    views: { name: string; sql: string }[],
    newName?: string
): string {
    let queries = "";

    // 1. Base Query
    if (action === "RENAME" && newName) {
        queries += `ALTER TABLE "${tableName}" RENAME TO "${newName}";\n`;
    } else if (action === "DROP") {
        queries += `DROP TABLE "${tableName}";\n`;
    }

    // 2. Cascade through dependent Views
    views.forEach((view) => {
        const fromRegex = new RegExp(`(FROM|JOIN)\\s+["'\`\\[]?${tableName}["'\`\\]]?`, "gi");
        const prefixRegex = new RegExp(`\\b${tableName}\\.`, "gi");

        if (fromRegex.test(view.sql) || prefixRegex.test(view.sql)) {
            if (action === "RENAME" && newName) {
                let updatedSql = view.sql.replace(fromRegex, `$1 "${newName}"`);
                updatedSql = updatedSql.replace(prefixRegex, `"${newName}".`);
                queries += `DROP VIEW "${view.name}";\n${updatedSql};\n`;
            } else if (action === "DROP") {
                queries += `DROP VIEW "${view.name}";\n`;
            }
        }
    });

    return queries.trim();
}

/**
 * Safely extracts the primary table name from a SELECT query using regex.
 * Handles quotes, brackets, backticks, and standard naming.
 */
export function extractTableNameFromQuery(query: string): string | null {
    if (!query) return null;
    const match = query.match(/FROM\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|\[([^\]]+)\]|([a-zA-Z0-9_а-яА-ЯёЁ]+))/i);
    return match ? match[1] || match[2] || match[3] || match[4] || match[5] : null;
}

/**
 * Builds an INSERT query for the Live Editor Ghost Row.
 * Safely handles form inputs, or falls back to database schema defaults if the user did a "Quick Insert".
 */
export function buildInlineInsertQuery(
    tableName: string,
    columnsInfo: SqlValue[][],
    pkColumnName: string | null,
    formData?: Record<string, string>
): { query: string; values: SqlValue[] } {
    const cols: string[] = [];
    const vals: SqlValue[] = [];
    const placeholders: string[] = [];

    // User provided explicit form data
    if (formData && Object.keys(formData).length > 0) {
        for (const [key, val] of Object.entries(formData)) {
            cols.push(`"${key}"`);
            vals.push(val);
            placeholders.push("?");
        }
    } else {
        // Quick Insert: Generate safe defaults based on the database schema
        columnsInfo.forEach((colMeta) => {
            const colName = String(colMeta[1]);
            const type = String(colMeta[2]).toUpperCase();
            // const notNull = colMeta[3] === 1;
            const defaultVal = colMeta[4];
            const isPk = pkColumnName === colName;

            if (isPk || defaultVal !== null) return; // SQLite engine handles auto-increments and defaults automatically

            cols.push(`"${colName}"`);
            placeholders.push("?");

            if (type.includes("INT") || type.includes("NUM") || type.includes("REAL"))
                vals.push(0);
            else
                vals.push("");
        });
    }

    let query = `INSERT INTO "${tableName}"`;
    if (cols.length > 0) {
        query += ` (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`;
    } else {
        query += ` DEFAULT VALUES`;
    }

    return { query, values: vals };
}

export type CellRenderMode = "markdown" | "editable" | "readonly";

/**
 * Pure logic to determine exactly how a cell should render based on the current state.
 */
export function determineCellRenderMode(
    val: SqlValue,
    colName: string,
    pkColumnName: string | null,
    isEditMode: boolean,
    forceRaw: boolean,
    settingsAllowMarkdown: boolean
): { displayValue: string; mode: CellRenderMode } {
    const displayValue = val !== null ? String(val) : "NULL";

    if (!forceRaw && !isEditMode && settingsAllowMarkdown) {
        return { displayValue, mode: "markdown" };
    }

    if (isEditMode && pkColumnName) {
        const normalizedCol = colName.trim().toLowerCase();
        const normalizedPk = pkColumnName.trim().toLowerCase();
        if (normalizedCol !== normalizedPk) {
            return { displayValue, mode: "editable" };
        }
        return { displayValue, mode: "readonly" };
    }

    return { displayValue, mode: "readonly" };
}

/**
 * Pure function for the Magnetic Proximity Scanner.
 * Completely decoupled from Obsidian's Editor API for pure testability.
 */
export function scanForMarkdownTable(
    lineCount: number,
    getLine: (i: number) => string,
    cursorFrom: number,
    cursorTo: number,
    hasSelection: boolean
): string[] {
    const lines: string[] = [];

    // 1. If highlighted, verify it actually contains a table
    if (hasSelection) {
        const selLines = [];
        for (let i = cursorFrom; i <= cursorTo; i++) selLines.push(getLine(i));
        const validLines = selLines.map((l) => l.trim()).filter((l) => l.length > 0);

        if (validLines.length >= 3 && validLines.some((l) => l.includes("|"))) {
            return validLines;
        }
    }

    // 2. Magnetic Scanner
    let targetLine = cursorFrom;
    let foundTable = false;

    // Scan top of selection
    for (let offset = 0; offset <= 3; offset++) {
        if (cursorFrom - offset >= 0 && getLine(cursorFrom - offset).includes("|")) {
            targetLine = cursorFrom - offset;
            foundTable = true;
            break;
        }
        if (cursorFrom + offset < lineCount && getLine(cursorFrom + offset).includes("|")) {
            targetLine = cursorFrom + offset;
            foundTable = true;
            break;
        }
    }

    // Scan bottom of selection
    if (!foundTable && hasSelection) {
        for (let offset = 0; offset <= 3; offset++) {
            if (cursorTo - offset >= 0 && getLine(cursorTo - offset).includes("|")) {
                targetLine = cursorTo - offset;
                foundTable = true;
                break;
            }
            if (cursorTo + offset < lineCount && getLine(cursorTo + offset).includes("|")) {
                targetLine = cursorTo + offset;
                foundTable = true;
                break;
            }
        }
    }

    if (!foundTable) return [];

    // 3. Lock onto borders
    let startLine = targetLine;
    while (startLine > 0 && getLine(startLine - 1).includes("|")) startLine--;

    let endLine = targetLine;
    while (endLine < lineCount - 1 && getLine(endLine + 1).includes("|")) endLine++;

    for (let i = startLine; i <= endLine; i++) {
        const l = getLine(i).trim();
        if (l) lines.push(l);
    }

    return lines;
}

/**
 * Analyzes PRAGMA table_info results to produce a clean,
 * typed schema object that the renderer can easily consume.
 */
export function parseTableSchema(tableInfoRows: SqlValue[][]) {
    const columns = tableInfoRows.map((row) => ({
        cid: Number(row[0]),
        name: String(row[1]),
        type: String(row[2]),
        notNull: row[3] === 1,
        defaultValue: row[4],
        isPk: row[5] === 1,
    }));

    const pk = columns.find((c) => c.isPk) || null;

    return {
        columns,
        pkColumnName: pk ? pk.name : null,
        hasPk: !!pk,
    };
}

/**
 * Fetches dashboard stats (table count, view count).
 */
export function getDatabaseStats(db: Database) {
    const tableRes = db.exec("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    const tableCount = tableRes.length > 0 && tableRes[0].values.length > 0 ? Number(tableRes[0].values[0][0]) : 0;

    const viewRes = db.exec("SELECT COUNT(*) FROM sqlite_master WHERE type='view'");
    const viewCount = viewRes.length > 0 && viewRes[0].values.length > 0 ? Number(viewRes[0].values[0][0]) : 0;

    return { tableCount, viewCount };
}

export interface SidebarObject {
    name: string;
    type: "table" | "view";
}

/**
 * Fetches and sorts database objects (tables and views).
 */
export function getSidebarObjects(db: Database): SidebarObject[] {
    const result = db.exec(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name;"
    );

    if (result.length === 0) return [];

    return result[0].values.map((row: SqlValue[]) => ({
        name: String(row[0]),
        type: row[1] === "view" ? "view" : "table",
    }));
}

/**
 * Safely parses active UI filters and appends a WHERE wrapper around the base query.
 */
export function applyFiltersToQuery(
    baseQuery: string,
    filters?: Record<string, { condition: string; values: string[] }>
): string {
    if (!filters || Object.keys(filters).length === 0) return baseQuery;

    const query = baseQuery.trim().replace(/;$/, "");
    if (!query.toUpperCase().startsWith("SELECT")) return baseQuery;

    let whereClauses: string[] = [];

    for (const [col, filter] of Object.entries(filters)) {
        const safeCol = `"${col.replace(/"/g, '""')}"`;
        let conditions: string[] = [];

        if (filter.condition) {
            const cond = filter.condition.trim();
            // Match math operators (>=, <=, >, <, !=, =)
            const numCondMatch = cond.match(/^(>=|<=|>|<|!=|=)\s*(.+)$/);

            if (numCondMatch) {
                const op = numCondMatch[1];
                const val = numCondMatch[2].replace(/'/g, "''");
                if (!isNaN(Number(val)) && val !== "") {
                    conditions.push(`CAST(${safeCol} AS NUMERIC) ${op} ${Number(val)}`);
                } else {
                    conditions.push(`${safeCol} ${op} '${val}'`);
                }
            } else {
                // Fallback to text fuzzy matching
                conditions.push(`LOWER(CAST(${safeCol} AS TEXT)) LIKE LOWER('%${cond.replace(/'/g, "''")}%')`);
            }
        }

        if (filter.values && filter.values.length > 0) {
            const inVals = filter.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
            conditions.push(`CAST(${safeCol} AS TEXT) IN (${inVals})`);
        }

        if (conditions.length > 0) {
            whereClauses.push(`(${conditions.join(" AND ")})`);
        }
    }

    if (whereClauses.length === 0) return baseQuery;
    return `SELECT * FROM (${query}) WHERE ${whereClauses.join(" AND ")}`;
}
