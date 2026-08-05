import type { Database, SqlValue } from "sql.js";

/**
 * Quotes a table or column name so that quotes, spaces and keywords in the
 * name cannot break out of the identifier.
 */
export function quoteIdent(name: string): string {
    return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Quotes a value as a SQL string literal. Prefer bound parameters where possible;
 * this exists for the few places that have to build SQL as text.
 */
export function quoteLiteral(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

/** Collapses separators and strips leading/trailing slashes from a vault path. */
function normalizeVaultPath(path: string): string {
    return String(path || "")
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .replace(/^\/+|\/+$/g, "");
}

/**
 * Resolves where one rotating backup slot of a database lives.
 *
 * An empty `backupFolder` keeps the copy next to the database itself. Otherwise
 * the database's own folder structure is mirrored under the chosen folder, so
 * two databases with the same file name cannot overwrite each other's backups.
 *
 * The database's own extension is kept (`stats.db` becomes `stats.backup-1.db`)
 * so that Obsidian shows the backup in the file explorer and it opens straight
 * into the SQLite view — an unregistered extension would be hidden instead.
 */
export function buildBackupPath(dbPath: string, backupFolder: string, slot: number): string {
    const normalized = normalizeVaultPath(dbPath);
    const fileName = normalized.split("/").pop() || normalized;
    const dbFolder = normalized.slice(0, Math.max(0, normalized.length - fileName.length - 1));

    const root = normalizeVaultPath(backupFolder);
    const folder = root ? [root, dbFolder].filter(Boolean).join("/") : dbFolder;

    // Split on the final dot only, so "my.notes.sqlite3" keeps "my.notes" as its stem
    const dot = fileName.lastIndexOf(".");
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const extension = dot > 0 ? fileName.slice(dot + 1) : "";

    const name = extension ? `${stem}.backup-${slot}.${extension}` : `${stem}.backup-${slot}`;
    return folder ? `${folder}/${name}` : name;
}

/**
 * True if a path looks like one of our backup slots. Used to keep backups out of
 * database pickers, and to avoid ever backing up a backup.
 */
export function isBackupPath(path: string): boolean {
    const fileName = normalizeVaultPath(path).split("/").pop() || "";
    return /\.backup-\d+(\.[^.]+)?$/.test(fileName);
}

/**
 * Escapes regex metacharacters so object names can be embedded in a pattern safely.
 */
export function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Blanks out comments and quoted text so keyword scanning cannot be fooled by a
 * table called "delete" or by the word INSERT inside a string literal.
 */
export function stripSqlNoise(sql: string): string {
    return String(sql || "")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--[^\n]*/g, " ")
        .replace(/'(?:[^']|'')*'/g, "''")
        .replace(/"(?:[^"]|"")*"/g, '""')
        .replace(/`[^`]*`/g, "``")
        .replace(/\[[^\]]*\]/g, "[]");
}

const MUTATING_STATEMENTS = [
    "INSERT",
    "REPLACE",
    "UPDATE",
    "DELETE",
    "CREATE",
    "DROP",
    "ALTER",
    "VACUUM",
    "REINDEX",
    "ATTACH",
    "DETACH",
    "ANALYZE",
];

const SCHEMA_STATEMENTS = ["CREATE", "DROP", "ALTER"];

/**
 * Decides whether a batch of SQL actually changes the database.
 *
 * Persisting a sql.js database means rewriting the entire file, so a plain SELECT
 * must never trigger a save: doing so would republish a stale in-memory snapshot
 * over whatever is currently on disk.
 */
export function analyzeSqlEffect(sql: string): { mutates: boolean; changesSchema: boolean } {
    let mutates = false;
    let changesSchema = false;

    for (const statement of stripSqlNoise(sql).split(";")) {
        const trimmed = statement.trim();
        if (!trimmed) continue;

        const keyword = (trimmed.match(/^[a-zA-Z]+/) || [""])[0].toUpperCase();

        if (keyword === "WITH") {
            // A CTE is read-only unless it feeds a write statement
            if (/\b(INSERT|REPLACE|UPDATE|DELETE)\b/i.test(trimmed)) mutates = true;
            continue;
        }
        if (keyword === "PRAGMA") {
            if (trimmed.includes("=")) mutates = true;
            continue;
        }

        if (MUTATING_STATEMENTS.includes(keyword)) mutates = true;
        if (SCHEMA_STATEMENTS.includes(keyword)) changesSchema = true;
    }

    return { mutates, changesSchema };
}

/**
 * Editable cells use the text "NULL" as the sentinel for a real SQL NULL, so a
 * literal "NULL" string has to be escaped on its way into the grid, otherwise
 * saving the cell untouched would silently destroy the value.
 */
export function formatCellForEdit(value: SqlValue): string {
    if (value === null) return "NULL";
    const text = String(value);
    return /^\\*NULL$/.test(text) ? `\\${text}` : text;
}

/**
 * Inverse of {@link formatCellForEdit}: turns grid text back into a stored value.
 */
export function parseCellInput(raw: string): string | null {
    if (raw === "NULL") return null;
    return /^\\+NULL$/.test(raw) ? raw.slice(1) : raw;
}

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
            let def = `${quoteIdent(c.name)} `;

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

    return `CREATE TABLE ${quoteIdent(tableName)} (\n    ${defs}\n);`;
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
    const safeTableName = quoteIdent(tableName);
    const safeHeaders = headers.map((h) => `${quoteIdent(h)} TEXT`);

    // Explicitly name the columns being inserted so the auto-increment ID is safely skipped
    const insertCols = headers.map((h) => quoteIdent(h)).join(", ");
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
        wrapper += ` ORDER BY ${quoteIdent(sortCol)} ${sortDir}`;
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
        queries += `ALTER TABLE ${quoteIdent(tableName)} RENAME TO ${quoteIdent(newName)};\n`;
    } else if (action === "DROP") {
        queries += `DROP TABLE ${quoteIdent(tableName)};\n`;
    }

    // 2. Cascade through dependent Views
    const escapedName = escapeRegex(tableName);
    views.forEach((view) => {
        const fromRegex = new RegExp(`(FROM|JOIN)\\s+["'\`\\[]?${escapedName}["'\`\\]]?`, "gi");
        const prefixRegex = new RegExp(`\\b${escapedName}\\.`, "gi");

        if (fromRegex.test(view.sql) || prefixRegex.test(view.sql)) {
            if (action === "RENAME" && newName) {
                let updatedSql = view.sql.replace(fromRegex, `$1 ${quoteIdent(newName)}`);
                updatedSql = updatedSql.replace(prefixRegex, `${quoteIdent(newName)}.`);
                queries += `DROP VIEW ${quoteIdent(view.name)};\n${updatedSql};\n`;
            } else if (action === "DROP") {
                queries += `DROP VIEW ${quoteIdent(view.name)};\n`;
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
            cols.push(quoteIdent(key));
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

            cols.push(quoteIdent(colName));
            placeholders.push("?");

            if (type.includes("INT") || type.includes("NUM") || type.includes("REAL")) vals.push(0);
            else vals.push("");
        });
    }

    let query = `INSERT INTO ${quoteIdent(tableName)}`;
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
            return { displayValue: formatCellForEdit(val), mode: "editable" };
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

    const whereClauses: string[] = [];

    for (const [col, filter] of Object.entries(filters)) {
        const safeCol = quoteIdent(col);
        const conditions: string[] = [];

        if (filter.condition) {
            const cond = filter.condition.trim();
            // Match math operators (>=, <=, >, <, !=, =)
            const numCondMatch = cond.match(/^(>=|<=|>|<|!=|=)\s*(.+)$/);

            if (numCondMatch) {
                const op = numCondMatch[1];
                const val = numCondMatch[2];
                if (!isNaN(Number(val)) && val.trim() !== "") {
                    conditions.push(`CAST(${safeCol} AS NUMERIC) ${op} ${Number(val)}`);
                } else {
                    conditions.push(`${safeCol} ${op} ${quoteLiteral(val)}`);
                }
            } else {
                // Fallback to text fuzzy matching
                conditions.push(`LOWER(CAST(${safeCol} AS TEXT)) LIKE LOWER(${quoteLiteral(`%${cond}%`)})`);
            }
        }

        if (filter.values && filter.values.length > 0) {
            const inVals = filter.values.map((v) => quoteLiteral(v)).join(", ");
            conditions.push(`CAST(${safeCol} AS TEXT) IN (${inVals})`);
        }

        if (conditions.length > 0) {
            whereClauses.push(`(${conditions.join(" AND ")})`);
        }
    }

    if (whereClauses.length === 0) return baseQuery;
    return `SELECT * FROM (${query}) WHERE ${whereClauses.join(" AND ")}`;
}
