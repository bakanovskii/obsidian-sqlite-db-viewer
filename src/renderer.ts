import { MarkdownRenderChild, TFile, MarkdownRenderer, Notice, sanitizeHTMLToDom } from "obsidian";
import type { Database, SqlValue } from "sql.js";
import { PAGINATION_NUMS, FILTER_UNIQUE_VALUES_LIMIT } from "./config";
import { applyIcon, createActionBtn } from "./utils";
import type { DbChangeReason, DbHandle } from "./db-manager";
import ObsidianSqlitePlugin from "./main";
import { ConfirmModal } from "./modals";
import {
    getTableThemeClass,
    calculatePagination,
    extractTableNameFromQuery,
    buildInlineInsertQuery,
    determineCellRenderMode,
    parseTableSchema,
    buildCountQuery,
    buildPaginatedQuery,
    applyFiltersToQuery,
    parseCellInput,
    quoteIdent,
} from "./formatters";

declare const activeDocument: Document;

interface PopupElement extends HTMLElement {
    closePopup?: () => void;
}

export interface ColumnSchema {
    name: string;
    type: string;
    isPk: boolean;
}

export class SqliteResultRenderer extends MarkdownRenderChild {
    isEditMode: boolean = false;
    tableName: string | null = null;
    pkColumn: ColumnSchema | null = null;
    columnsInfo: SqlValue[][] = [];

    /**
     * Shared connection for this file. Every renderer and view pointing at the same
     * database works on the very same in-memory instance, so nobody can overwrite
     * anybody else's changes with a stale snapshot.
     */
    private handle: DbHandle | null = null;
    private isUnloaded: boolean = false;
    /**
     * Bumped on every unload. An acquire still in flight from a previous life
     * compares it and gives its connection straight back instead of overwriting
     * the one this renderer is using now.
     */
    private generation: number = 0;
    /** In-flight check-out, so a burst of calls shares one connection instead of racing. */
    private acquiring: Promise<Database | null> | null = null;

    get activeDb(): Database | null {
        return this.handle ? this.handle.db : null;
    }

    lastDbResult: { columns: string[]; totalRows: number } | null = null;
    tableState: {
        page: number;
        rawLimit?: number;
        sortCol?: string;
        sortDir?: "ASC" | "DESC" | null;
        filters?: Record<string, { condition: string; values: string[] }>;
    } = { page: 0 };
    jumpToLastPage: boolean = false;

    toolbarEl!: HTMLElement;
    tableEl!: HTMLElement;

    constructor(
        containerEl: HTMLElement,
        private plugin: ObsidianSqlitePlugin,
        private query: string,
        private file: TFile,
        private forceRaw: boolean = false
    ) {
        super(containerEl);
    }

    onload() {
        // Obsidian reuses a rendered block: the same render child is unloaded when it
        // scrolls out of the viewport and loaded again when it comes back, so a load
        // is not necessarily the first one
        this.isUnloaded = false;
        this.lastDbResult = null;
        this.columnsInfo = [];
        void this.initializeDbAndRender();
    }

    async initializeDbAndRender() {
        try {
            const db = await this.ensureDb();
            if (this.isUnloaded) return;

            this.containerEl.empty();
            this.toolbarEl = this.containerEl.createDiv();
            this.tableEl = this.containerEl.createDiv();

            if (!db) {
                this.tableEl.createSpan({ text: "[DB connection unavailable]", cls: "sqlite-error" });
                return;
            }
        } catch (e) {
            this.containerEl.empty();
            this.containerEl.createSpan({ text: `[DB load error: ${String(e)}]`, cls: "sqlite-error" });
            return;
        }

        await this.loadDataAndRender();
    }

    /**
     * Returns a usable connection, checking out a new one when the handle we hold has
     * gone dead — this renderer was unloaded and loaded again, or the shared connection
     * was dropped after every other consumer let go of it. Without this a reused block
     * keeps its buttons and its table on screen while silently having no database
     * behind it: paging shows nothing and a refresh never finishes.
     */
    private async ensureDb(): Promise<Database | null> {
        if (this.isUnloaded) return null;

        const db = this.activeDb;
        if (db) return db;

        if (!this.acquiring) {
            this.acquiring = this.acquireHandle().finally(() => {
                this.acquiring = null;
            });
        }
        return this.acquiring;
    }

    private async acquireHandle(): Promise<Database | null> {
        const generation = this.generation;

        const stale = this.handle;
        this.handle = null;
        if (stale) stale.release();

        const handle = await this.plugin.dbManager.acquire(this.file);

        // Unloaded — or unloaded and loaded again — while the file was being read
        if (this.isUnloaded || generation !== this.generation) {
            handle.release();
            return null;
        }

        this.handle = handle;
        handle.onChange((reason) => this.onDatabaseChanged(reason));
        return handle.db;
    }

    /**
     * Somebody else changed this database: drop cached results and show the current data.
     *
     * The page is deliberately kept. Rows may well have gone, but `calculatePagination`
     * clamps whatever is left, and jumping back to page one on every change makes a
     * table you are editing impossible to work with.
     */
    private onDatabaseChanged(_reason: DbChangeReason) {
        if (this.isUnloaded || !this.tableEl) return;
        this.lastDbResult = null;
        this.columnsInfo = [];
        void this.loadDataAndRender();
    }

    onunload() {
        this.isUnloaded = true;
        this.generation++;
        this.acquiring = null;
        if (this.handle) {
            this.handle.release();
            this.handle = null;
        }
    }

    setEditMode(isEdit: boolean) {
        this.isEditMode = isEdit;
        if (this.lastDbResult) {
            this.renderTable();
        } else {
            void this.loadDataAndRender();
        }
    }

    async refresh() {
        await this.ensureDb();
        if (this.handle) await this.handle.reload();
        this.lastDbResult = null;
        this.columnsInfo = [];
        this.tableName = null;
        this.tableState.page = 0;
        this.tableState.filters = {};
        await this.loadDataAndRender();
        new Notice("Table refreshed!");
    }

    private async executeWrite(query: string, params: SqlValue[]) {
        const db = await this.ensureDb();
        if (!db || !this.handle) throw new Error("No database connection");

        const stmt = db.prepare(query);
        try {
            stmt.run(params);
        } finally {
            stmt.free();
        }

        await this.handle.save();
    }

    async updateQuery(newQuery: string) {
        this.query = newQuery;
        this.lastDbResult = null;
        this.columnsInfo = [];
        this.tableName = null;
        this.tableState.page = 0;
        this.tableState.filters = {};
        await this.loadDataAndRender();
    }

    async loadDataAndRender() {
        // The block may not have been built yet, or may have been torn down
        if (!this.tableEl || this.isUnloaded) return;

        if (!this.lastDbResult) {
            this.toolbarEl.empty();
            this.tableEl.empty();
            this.tableEl.setCssStyles({ display: "block" });
            this.tableEl.textContent = "⏳ Executing query...";
        }

        try {
            const db = await this.ensureDb();
            if (this.isUnloaded) return;

            // Never leave the spinner up: a dead connection has to be visible
            if (!db) {
                this.tableEl.empty();
                this.tableEl.createSpan({ text: "[DB connection lost — reopen the note]", cls: "sqlite-error" });
                return;
            }

            if (this.tableName === null && !this.forceRaw) {
                this.tableName = extractTableNameFromQuery(this.query);
            }

            if (this.tableName && this.columnsInfo.length === 0) {
                try {
                    const schema = db.exec(`PRAGMA table_info(${quoteIdent(this.tableName)});`);
                    if (schema.length > 0) {
                        const parsed = parseTableSchema(schema[0].values);
                        this.columnsInfo = schema[0].values;
                        const foundPk = parsed.columns.find((c) => c.name === parsed.pkColumnName);
                        this.pkColumn = foundPk ? { name: foundPk.name, type: foundPk.type, isPk: foundPk.isPk } : null;
                    } else {
                        this.tableName = null;
                    }
                } catch {
                    this.tableName = null;
                }
            }

            // 1. Memory Safe Column Extraction (Gets headers without pulling data)
            let columns: string[] = [];
            try {
                const stmt = db.prepare(this.query);
                columns = stmt.getColumnNames();
                stmt.free();
            } catch {
                // Ignore syntax errors while typing
            }

            // 2. Memory Safe Row Counting
            let totalRows = 0;
            const filteredQuery = applyFiltersToQuery(this.query, this.tableState.filters);
            const countQuery = buildCountQuery(filteredQuery);
            if (countQuery) {
                try {
                    const countRes = db.exec(countQuery);
                    if (countRes.length > 0 && countRes[0].values.length > 0) {
                        totalRows = Number(countRes[0].values[0][0]);
                    }
                } catch {
                    // Ignore invalid queries
                }
            } else {
                // Fallback for PRAGMA or non-SELECT queries
                try {
                    const res = db.exec(this.query);
                    if (res.length > 0) {
                        totalRows = res[0].values.length;
                        if (columns.length === 0) columns = res[0].columns;
                    }
                } catch {
                    // Ignore invalid queries
                }
            }

            if (totalRows > 0 || this.tableName) {
                this.toolbarEl.empty();
                if (this.isEditMode && !this.pkColumn && this.tableName) {
                    const warn = this.toolbarEl.createDiv({
                        text: "⚠️ Read-only: No Primary Key",
                        cls: "text-warning",
                    });
                    warn.setCssStyles({ fontSize: "12px", marginBottom: "10px" });
                }

                this.lastDbResult = { columns, totalRows };
                this.renderTable();
            } else {
                this.tableEl.empty();
                this.tableEl.textContent = "[Query executed: no data]";
            }
        } catch (e) {
            this.tableEl.empty();
            this.tableEl.createSpan({ text: `[SQL Error: ${String(e)}]`, cls: "sqlite-error" });
        }
    }

    renderTable() {
        if (!this.lastDbResult) return;

        if (this.jumpToLastPage) {
            const limit =
                this.tableState.rawLimit === 0
                    ? Math.max(this.lastDbResult.totalRows, 1)
                    : this.tableState.rawLimit || this.plugin.settings.defaultRowLimit;
            const totalPages = Math.ceil(this.lastDbResult.totalRows / limit) || 1;
            this.tableState.page = totalPages - 1;
            this.jumpToLastPage = false;
        }

        this.tableEl.empty();

        renderDataTable(
            this.tableEl,
            this.lastDbResult.columns,
            this.lastDbResult.totalRows,
            this.plugin.settings.defaultRowLimit,
            this,
            this.tableState,
            this.plugin.settings.tableStyle,
            // THE SERVER-SIDE FETCH HOOK: Only pulls exactly what is needed for this page!
            async (limit, offset, sortCol, sortDir) => {
                // Paging is the most common way to touch a block that has been sitting
                // around for a while, so this is where a dead handle usually surfaces
                const db = await this.ensureDb();
                if (!db) {
                    new Notice("Lost the database connection. Refresh the table.");
                    return [];
                }

                const filteredQuery = applyFiltersToQuery(this.query, this.tableState.filters);
                const paginatedQuery = buildPaginatedQuery(filteredQuery, sortCol, sortDir, limit, offset);
                try {
                    const res = db.exec(paginatedQuery);
                    return res.length > 0 ? res[0].values : [];
                } catch (e) {
                    new Notice(`Query error: ${String(e)}`);
                    return [];
                }
            },
            (col) => this.getUniqueValues(col),
            (col, cond, vals) => void this.applyFilter(col, cond, vals),
            (val, td, cellComponent, row, colName) => {
                const { displayValue, mode } = determineCellRenderMode(
                    val,
                    colName || "",
                    this.pkColumn ? this.pkColumn.name : null,
                    this.isEditMode,
                    this.forceRaw,
                    this.plugin.settings.renderMarkdownInCells
                );

                if (mode === "markdown") {
                    void MarkdownRenderer.render(this.plugin.app, displayValue, td, this.file.path, cellComponent).then(
                        () => {
                            const p = td.querySelector("p");
                            if (p) {
                                p.setCssStyles({ margin: "0", padding: "0" });
                            }
                        }
                    );
                } else {
                    // Zero-width space (\u200B), so we can put cursor in empty blocks!
                    td.textContent = displayValue === "" ? "\u200B" : displayValue;

                    if (mode === "editable" && row && this.lastDbResult) {
                        const pkIndex = this.lastDbResult.columns.indexOf(this.pkColumn!.name);
                        const rowPkValue = pkIndex !== -1 ? row[pkIndex] : null;

                        td.contentEditable = "true";
                        td.classList.add("sqlite-editable-cell");

                        // Tracks what is actually stored, so a second blur without an
                        // edit cannot re-submit a value that was already written
                        let committedText = displayValue;

                        td.onfocus = () => {
                            td.setCssStyles({ backgroundColor: "var(--background-modifier-hover)" });

                            // Drop the placeholder before anything is typed or pasted. It is
                            // invisible but not weightless: left sitting in front of the new
                            // value it nudges the text, and the column, sideways
                            if (td.textContent === "\u200B") td.textContent = "";
                        };
                        td.onpaste = (e) => {
                            // A cell holds text. Pasting from a note or a browser would
                            // otherwise drop styled markup into the table
                            e.preventDefault();
                            const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\u200B/g, "");
                            if (!text) return;

                            const selection = activeWindow.getSelection();
                            const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
                            if (!range || !td.contains(range.commonAncestorContainer)) {
                                td.textContent = (td.textContent || "") + text;
                                return;
                            }

                            range.deleteContents();
                            const inserted = activeDocument.createTextNode(text);
                            range.insertNode(inserted);

                            // Leave the caret after what was just pasted
                            range.setStartAfter(inserted);
                            range.collapse(true);
                            selection!.removeAllRanges();
                            selection!.addRange(range);
                        };
                        td.onblur = () => {
                            td.setCssStyles({ backgroundColor: "transparent" });

                            // Remove zero-width space before saving and replacing
                            const newText = (td.textContent || "").replace(/\u200B/g, "");

                            // What stays on screen has to be exactly what was stored: the cell
                            // is not re-rendered after a successful edit
                            const display = newText === "" ? "\u200B" : newText;
                            if (td.textContent !== display) td.textContent = display;

                            if (newText === committedText) return;

                            committedText = newText;
                            const colIndex = this.lastDbResult!.columns.indexOf(colName!);
                            void this.updateCell(colName!, parseCellInput(newText), rowPkValue, row, colIndex);
                        };
                        td.onkeydown = (e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                td.blur();
                            } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
                                const selection = activeWindow.getSelection();
                                if (!selection) return;

                                // Don't forget to remove zero-width empty space too
                                const textLen = (td.textContent || "").replace(/\u200B/g, "").length;

                                let charOffset = selection.anchorOffset;
                                if (selection.anchorNode === td) {
                                    // If we're on the <td> itself, offset shows child-node index (0=start, >0=end)
                                    charOffset = selection.anchorOffset === 0 ? 0 : textLen;
                                }

                                // const offset = selection.anchorOffset;
                                let shouldJump = false;
                                if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                                    shouldJump = true;
                                } else if (selection.isCollapsed) {
                                    if (e.key === "ArrowLeft" && charOffset === 0) shouldJump = true;
                                    if (e.key === "ArrowRight" && charOffset >= textLen) shouldJump = true;
                                }

                                if (shouldJump) {
                                    e.preventDefault();
                                    e.stopPropagation();

                                    const tr = td.parentElement as HTMLTableRowElement;
                                    const tbody = tr.parentElement as HTMLTableSectionElement;
                                    const cellIdx = Array.from(tr.children).indexOf(td);
                                    const rowIdx = Array.from(tbody.children).indexOf(tr);

                                    let targetTd: HTMLElement | null = null;

                                    if (e.key === "ArrowLeft" && cellIdx > 0)
                                        targetTd = tr.children[cellIdx - 1] as HTMLElement;
                                    else if (e.key === "ArrowRight" && cellIdx < tr.children.length - 1)
                                        targetTd = tr.children[cellIdx + 1] as HTMLElement;
                                    else if (e.key === "ArrowUp" && rowIdx > 0)
                                        targetTd = tbody.children[rowIdx - 1].children[cellIdx] as HTMLElement;
                                    else if (e.key === "ArrowDown" && rowIdx < tbody.children.length - 1)
                                        targetTd = tbody.children[rowIdx + 1].children[cellIdx] as HTMLElement;

                                    if (targetTd && targetTd.contentEditable === "true") {
                                        targetTd.focus();

                                        const newRange = activeDocument.createRange();
                                        newRange.selectNodeContents(targetTd);

                                        // From right to left -> EOL
                                        if (e.key === "ArrowLeft") {
                                            newRange.collapse(false);
                                        } else if (e.key === "ArrowRight") {
                                            // From left to right -> SOL
                                            newRange.collapse(true);
                                        } else {
                                            // If it is closer to start -> SOL, clother to end -> EOL
                                            newRange.collapse(textLen === 0 ? true : charOffset <= textLen / 2);
                                        }

                                        selection.removeAllRanges();
                                        selection.addRange(newRange);
                                    }
                                } else {
                                    // Block popup so Obsidian won't lose focus on common move
                                    e.stopPropagation();
                                }
                            }
                        };
                    } else if (mode === "readonly" && this.isEditMode) {
                        td.setCssStyles({
                            backgroundColor: "var(--background-secondary)",
                            color: "var(--text-muted)",
                            cursor: "not-allowed",
                        });
                    }
                }
            },
            (tbody, colCount) => {
                if (this.isEditMode && this.tableName) {
                    this.renderGhostRow(tbody, colCount);
                }
            },
            (tr, row) => {
                if (!this.isEditMode || !this.pkColumn || !this.tableName || !this.lastDbResult) return;

                // Grab the last cell in the row and safely inject the button inside it
                const lastTd = tr.lastElementChild as HTMLElement;
                if (!lastTd) return;
                lastTd.setCssStyles({ position: "relative" });

                const delBtn = lastTd.createDiv({ cls: "sqlite-row-action" });
                applyIcon(delBtn, "trash");

                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    const pkIndex = this.lastDbResult!.columns.indexOf(this.pkColumn!.name);
                    const pkValue = row[pkIndex];

                    new ConfirmModal(
                        this.plugin.app,
                        "Delete Row",
                        `Are you sure you want to delete this row? (${this.pkColumn!.name} = ${String(pkValue)})`,
                        () => {
                            void this.deleteRow(pkValue);
                        }
                    ).open();
                };
            }
        );
    }

    async updateCell(colName: string, newVal: string | null, pkValue: SqlValue, row: SqlValue[], colIndex: number) {
        try {
            await this.executeWrite(
                `UPDATE ${quoteIdent(this.tableName!)} SET ${quoteIdent(colName)} = ? WHERE ${quoteIdent(this.pkColumn!.name)} = ?`,
                [newVal, pkValue]
            );

            row[colIndex] = newVal;
            new Notice("Row updated!");
        } catch (e) {
            new Notice(`Update error: ${String(e)}`);
            await this.loadDataAndRender();
        }
    }

    async deleteRow(pkValue: SqlValue) {
        try {
            await this.executeWrite(
                `DELETE FROM ${quoteIdent(this.tableName!)} WHERE ${quoteIdent(this.pkColumn!.name)} = ?`,
                [pkValue]
            );
            await this.loadDataAndRender();
            new Notice("Row deleted!");
        } catch (e) {
            new Notice(`Delete error: ${String(e)}`);
        }
    }

    renderGhostRow(tbody: HTMLElement, colCount: number) {
        const tr = tbody.createEl("tr", { cls: "sqlite-ghost-row" });
        const td = tr.createEl("td");
        td.colSpan = colCount;

        const promptWrapper = td.createDiv({ cls: "sqlite-ghost-prompt" });
        applyIcon(promptWrapper.createSpan(), "plus");
        promptWrapper.createSpan({ text: "New row..." });

        const formWrapper = td.createDiv({ cls: "sqlite-ghost-form" });
        const inputs: Record<string, HTMLInputElement> = {};

        this.columnsInfo.forEach((colMeta) => {
            const colName = String(colMeta[1]);
            const isPk = this.pkColumn && this.pkColumn.name === colName;
            const hasDefault = colMeta[4] !== null;
            const isAuto = isPk || hasDefault;

            const field = formWrapper.createDiv({ cls: "sqlite-ghost-field" });
            field.createEl("label", { text: colName + (isAuto ? " (AUTO)" : "") });

            const inp = field.createEl("input", { type: "text" });
            if (isAuto) {
                inp.disabled = true;
                inp.placeholder = hasDefault ? "DEFAULT" : "AUTO";
            } else {
                inputs[colName] = inp;
            }
        });

        const btnGroup = formWrapper.createDiv({ cls: "sqlite-ghost-btn-group" });

        const cancelBtn = btnGroup.createEl("button", { cls: "sqlite-action-btn" });
        cancelBtn.textContent = "Cancel";
        cancelBtn.onclick = (e) => {
            e.stopPropagation();
            formWrapper.setCssStyles({ display: "none" });
            promptWrapper.setCssStyles({ display: "flex" });
        };

        const saveNewBtn = createActionBtn(btnGroup, "save", "Save", (e) => {
            e.stopPropagation();

            void (async () => {
                const formData: Record<string, string> = {};
                Object.keys(inputs).forEach((key) => (formData[key] = inputs[key].value));

                const { query, values } = buildInlineInsertQuery(
                    this.tableName!,
                    this.columnsInfo,
                    this.pkColumn?.name || null,
                    formData
                );
                try {
                    await this.executeWrite(query, values);
                    this.jumpToLastPage = true;
                    await this.loadDataAndRender();
                    new Notice("Row added!");
                } catch (e) {
                    new Notice(`Insertion error: ${String(e)}`);
                }
            })();
        });
        saveNewBtn.classList.add("is-cta");

        promptWrapper.onclick = (e) => {
            e.stopPropagation();
            void (async () => {
                try {
                    const { query, values } = buildInlineInsertQuery(
                        this.tableName!,
                        this.columnsInfo,
                        this.pkColumn?.name || null
                    );
                    await this.executeWrite(query, values);
                    this.jumpToLastPage = true;
                    await this.loadDataAndRender();
                } catch {
                    promptWrapper.setCssStyles({ display: "none" });
                    formWrapper.setCssStyles({ display: "flex" });
                }
            })();
        };
    }

    async applyFilter(colName: string, condition: string, values: string[]) {
        if (!this.tableState.filters) this.tableState.filters = {};

        if (!condition && values.length === 0) {
            delete this.tableState.filters[colName];
        } else {
            this.tableState.filters[colName] = { condition, values };
        }

        this.tableState.page = 0;

        if (this.activeDb && this.lastDbResult) {
            const filteredQuery = applyFiltersToQuery(this.query, this.tableState.filters);
            const countQuery = buildCountQuery(filteredQuery);
            if (countQuery) {
                try {
                    const countRes = this.activeDb.exec(countQuery);
                    if (countRes.length > 0 && countRes[0].values.length > 0) {
                        this.lastDbResult.totalRows = Number(countRes[0].values[0][0]);
                    }
                } catch {
                    // ignore query errors while filtering
                }
            }
        }
        this.renderTable();
    }

    getUniqueValues(colName: string): string[] {
        if (!this.activeDb) return [];
        try {
            // Drop THIS column's filter so we can fetch all mutually available options based on other filters
            const filtersCopy = { ...this.tableState.filters };
            delete filtersCopy[colName];

            const query = applyFiltersToQuery(this.query, filtersCopy);
            const safeCol = quoteIdent(colName);

            const distinctQuery = `SELECT DISTINCT ${safeCol} FROM (${query}) WHERE ${safeCol} IS NOT NULL ORDER BY ${safeCol} LIMIT ${FILTER_UNIQUE_VALUES_LIMIT};`;
            const res = this.activeDb.exec(distinctQuery);
            if (res.length > 0) {
                return res[0].values.map((r) => String(r[0]));
            }
        } catch {
            // ignore syntax errors
        }
        return [];
    }

    async copyToClipboard() {
        try {
            const db = await this.ensureDb();
            if (!db) {
                new Notice("No database connection.");
                return;
            }

            const activeQuery = applyFiltersToQuery(this.query, this.tableState.filters);
            const res = db.exec(activeQuery);

            if (res.length > 0) {
                const cols = res[0].columns;
                const vals = res[0].values;

                let md = `| ${cols.join(" | ")} |\n`;
                md += `| ${cols.map(() => "---").join(" | ")} |\n`;

                vals.forEach((row) => {
                    md += `| ${row.map((cell) => (cell !== null ? String(cell).replace(/\|/g, "\\|") : "")).join(" | ")} |\n`;
                });

                await navigator.clipboard.writeText(md);
                new Notice("Copied filtered view as Markdown!");
            } else {
                new Notice("No data to copy.");
            }
        } catch (e) {
            new Notice(`Failed to copy data: ${String(e)}`);
        }
    }
}

export function buildDbWindowUI(
    wrapper: HTMLElement,
    titleText: string,
    onEdit?: (e: MouseEvent) => void,
    onOpenDb?: (e: MouseEvent) => void,
    onToggleEditMode?: (isEdit: boolean) => void,
    onRefresh?: (e: MouseEvent) => void,
    onCopyAsMarkdown?: (e: MouseEvent) => void
): HTMLElement {
    wrapper.classList.add("sqlite-db-window", "markdown-rendered");

    const header = wrapper.createDiv({ cls: "sqlite-db-header" });
    const titleContainer = header.createDiv({ cls: "sqlite-db-title-container" });
    const dbIcon = titleContainer.createSpan({ cls: "sqlite-db-icon" });
    applyIcon(dbIcon, "database");
    titleContainer.createSpan({ text: titleText, cls: "sqlite-db-title" });

    const btnGroup = header.createDiv({ cls: "sqlite-db-buttons sqlite-hide-in-reading" });

    if (onToggleEditMode) {
        const editModeBtn = btnGroup.createSpan({ cls: "sqlite-icon-btn sqlite-action" });
        applyIcon(editModeBtn, "pencil");
        editModeBtn.title = "Toggle Edit Mode (Live)";

        let isEdit = false;
        editModeBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            isEdit = !isEdit;
            if (isEdit) {
                editModeBtn.setCssStyles({
                    opacity: "1",
                    color: "var(--interactive-accent)",
                    filter: "drop-shadow(0 0 5px var(--interactive-accent))",
                });
            } else {
                editModeBtn.setCssStyles({
                    opacity: "0.5",
                    color: "inherit",
                    filter: "none",
                });
            }
            onToggleEditMode(isEdit);
        };
        editModeBtn.onmouseenter = () => {
            if (!isEdit) editModeBtn.setCssStyles({ opacity: "0.8" });
        };
        editModeBtn.onmouseleave = () => {
            if (!isEdit) editModeBtn.setCssStyles({ opacity: "0.5" });
        };
    }

    if (onCopyAsMarkdown) {
        const copyMdBtn = btnGroup.createSpan({ cls: "sqlite-icon-btn sqlite-action" });
        applyIcon(copyMdBtn, "clipboard-copy");
        copyMdBtn.title = "Copy view as Markdown Table";
        copyMdBtn.onclick = (e) => {
            e.stopPropagation();
            onCopyAsMarkdown(e);
            copyMdBtn.setCssStyles({
                opacity: "1",
                color: "var(--interactive-accent)",
                filter: "drop-shadow(0 0 5px var(--interactive-accent))",
            });
            window.setTimeout(
                () =>
                    copyMdBtn.setCssStyles({
                        opacity: "0.5",
                        color: "inherit",
                        filter: "none",
                    }),
                250
            );
        };
    }

    if (onEdit) {
        const editBtn = btnGroup.createSpan({ cls: "sqlite-icon-btn sqlite-action" });
        applyIcon(editBtn, "code");
        editBtn.title = "Edit code";
        editBtn.onclick = onEdit;
    }

    if (onRefresh) {
        const refreshBtn = btnGroup.createSpan({ cls: "sqlite-icon-btn sqlite-action" });
        applyIcon(refreshBtn, "refresh-cw");
        refreshBtn.title = "Refresh Table";
        refreshBtn.onclick = onRefresh;
    }

    if (onOpenDb) {
        const openDbBtn = btnGroup.createSpan({ cls: "sqlite-icon-btn sqlite-action" });
        applyIcon(openDbBtn, "database");
        openDbBtn.title = "Open DB Explorer";
        openDbBtn.onclick = onOpenDb;
    }

    const tableContainer = wrapper.createDiv();
    tableContainer.setCssStyles({
        padding: "10px",
        overflowX: "auto",
        userSelect: "text",
    });

    return tableContainer;
}

export function buildPaginationUI(
    container: HTMLElement,
    rawLimit: number,
    currentPage: number,
    totalRows: number,
    onPageChange: (newPage: number) => void,
    onLimitChange: (newLimit: number) => void
) {
    const { totalPages } = calculatePagination(rawLimit, totalRows, currentPage);
    const pageControls = container.createDiv({ cls: "sqlite-pagination" });

    const limitSelector = pageControls.createDiv({ cls: "sqlite-pagination-limit" });
    limitSelector.createSpan({ text: "Rows: " });
    const select = limitSelector.createEl("select", { cls: "sqlite-pagination-select" });
    PAGINATION_NUMS.forEach((val) => {
        const opt = select.createEl("option", { value: String(val), text: val === 0 ? "All" : String(val) });
        if (val === rawLimit) opt.selected = true;
    });
    select.onchange = (e) => {
        e.stopPropagation();
        const val = parseInt(select.value, 10);
        onLimitChange(val);
    };

    const nav = pageControls.createDiv({ cls: "sqlite-pagination-nav" });
    const prevBtn = nav.createEl("button", { cls: "sqlite-pagination-btn", text: "◀" });
    prevBtn.disabled = currentPage === 0;
    prevBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (currentPage > 0) onPageChange(currentPage - 1);
    };

    const pageIndicator = nav.createSpan({ cls: "sqlite-pagination-indicator" });
    pageIndicator.createSpan({ text: "Page" });
    const pageInput = pageIndicator.createEl("input", { cls: "sqlite-pagination-input", type: "number" });
    pageInput.value = String(currentPage + 1);
    pageInput.min = "1";
    pageInput.max = String(totalPages);
    pageIndicator.createSpan({ text: `of ${totalPages}` });

    pageInput.onchange = (e) => {
        e.stopPropagation();
        let val = parseInt(pageInput.value, 10);
        if (isNaN(val) || val < 1) val = 1;
        if (val > totalPages) val = totalPages;
        onPageChange(val - 1);
    };

    const nextBtn = nav.createEl("button", { cls: "sqlite-pagination-btn", text: "▶" });
    nextBtn.disabled = currentPage >= totalPages - 1;
    nextBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (currentPage < totalPages - 1) onPageChange(currentPage + 1);
    };
}

export function renderDataTable(
    container: HTMLElement,
    columns: string[],
    totalRows: number,
    initialLimit: number,
    parentComponent: MarkdownRenderChild,
    tableState: {
        page: number;
        rawLimit?: number;
        sortCol?: string;
        sortDir?: "ASC" | "DESC" | null;
        filters?: Record<string, { condition: string; values: string[] }>;
    },
    tableStyle: string,
    fetchData: (
        limit: number,
        offset: number,
        sortCol?: string,
        sortDir?: "ASC" | "DESC" | null
    ) => Promise<SqlValue[][]>,
    getUniqueValues: (colName: string) => string[],
    onFilterChange: (colName: string, condition: string, values: string[]) => void,
    renderCell: (
        val: SqlValue,
        td: HTMLElement,
        cellComponent: MarkdownRenderChild,
        row?: SqlValue[],
        colName?: string
    ) => void,
    renderGhostRow?: (tbody: HTMLElement, colCount: number) => void,
    renderRowAction?: (tr: HTMLElement, row: SqlValue[]) => void
) {
    if (tableState.rawLimit === undefined) {
        tableState.rawLimit = initialLimit;
    }
    let activePageChild: MarkdownRenderChild | null = null;

    container.empty();
    const wrapper = container.createDiv({ cls: "sqlite-table-wrapper" });
    const tableCls = getTableThemeClass(tableStyle);

    const table = wrapper.createEl("table", { cls: tableCls });
    table.setCssStyles({
        width: "max-content",
        minWidth: "100%",
        borderCollapse: "collapse",
        borderSpacing: "0",
    });

    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    columns.forEach((col: string) => {
        const th = headerRow.createEl("th");
        const thContent = th.createDiv({ cls: "sqlite-th-content" });
        const titleSpan = thContent.createSpan({ text: col });

        titleSpan.onclick = (e) => {
            e.stopPropagation();
            window.getSelection()?.removeAllRanges();

            if (tableState.sortCol === col) {
                if (tableState.sortDir === "ASC") tableState.sortDir = "DESC";
                else if (tableState.sortDir === "DESC") {
                    tableState.sortDir = null;
                    tableState.sortCol = undefined;
                }
            } else {
                tableState.sortCol = col;
                tableState.sortDir = "ASC";
            }
            updateHeaderClasses();
            tableState.page = 0;
            void renderPage();
        };

        const filterBtn = thContent.createSpan({ cls: "sqlite-filter-btn" });
        applyIcon(filterBtn, "filter");

        if (tableState.filters && tableState.filters[col]) {
            filterBtn.classList.add("is-active");
        }

        // Fix Filter Window Scroll Closing & Double Click Toggling
        filterBtn.onclick = (e) => {
            e.stopPropagation();

            // Check if THIS specific column popup is already open
            const existingPopup = activeDocument.querySelector(".sqlite-filter-popup");
            const wasOpenForThisCol = existingPopup && existingPopup.getAttribute("data-col") === col;

            // Close any open popups immediately
            if (existingPopup) {
                // Safely use the exposed cleanup method to remove global event listeners
                const popupEl = existingPopup as PopupElement;
                if (typeof popupEl.closePopup === "function") {
                    popupEl.closePopup();
                } else {
                    existingPopup.remove();
                }
            }

            // If it was already open for this column, we just wanted to close it, so stop here.
            if (wasOpenForThisCol) return;

            showFilterPopup(e, col, tableState.filters?.[col], getUniqueValues, (cond, vals) =>
                onFilterChange(col, cond, vals)
            );
        };
    });

    const updateHeaderClasses = () => {
        const ths = headerRow.querySelectorAll("th");
        ths.forEach((th, idx) => {
            th.classList.remove("sqlite-sort-asc", "sqlite-sort-desc");
            if (tableState.sortCol === columns[idx] && tableState.sortDir !== null) {
                th.classList.add(tableState.sortDir === "ASC" ? "sqlite-sort-asc" : "sqlite-sort-desc");
            }
        });
    };
    // Call once on load to set initial state
    updateHeaderClasses();

    const tbody = table.createEl("tbody");
    // Placeholder for pagination
    const paginationContainer = container.createDiv();

    const renderPage = async () => {
        if (activePageChild) {
            parentComponent.removeChild(activePageChild);
            activePageChild.unload();
        }

        activePageChild = new MarkdownRenderChild(container);
        parentComponent.addChild(activePageChild);

        // Visual loading state
        tbody.empty();
        const loadingTd = tbody.createEl("tr").createEl("td", {
            text: "⏳ Loading data...",
            cls: "text-muted",
        });
        loadingTd.colSpan = columns.length || 1;
        loadingTd.setCssStyles({ textAlign: "center" });

        const { startIndex, validPage, actualLimit } = calculatePagination(
            tableState.rawLimit!,
            totalRows,
            tableState.page
        );
        tableState.page = validPage;

        // SERVER-SIDE TRIGGER: Only fetches the exact items needed
        const pageValues = await fetchData(actualLimit, startIndex, tableState.sortCol, tableState.sortDir);

        // Clear loading text
        tbody.empty();

        // Rows are built off-document and inserted in one go, so a full page costs one reflow
        const fragment = createFragment();

        for (const row of pageValues) {
            const tr = fragment.createEl("tr");
            tr.setCssStyles({ position: "relative" });

            row.forEach((val: SqlValue, index: number) => {
                const td = tr.createEl("td");
                const displayVal = val !== null ? String(val) : "NULL";
                td.title = displayVal;

                renderCell(val, td, activePageChild!, row, columns[index]);
            });

            if (renderRowAction) {
                renderRowAction(tr, row);
            }
        }

        tbody.appendChild(fragment);

        if (renderGhostRow) {
            renderGhostRow(tbody, columns.length);
        }

        paginationContainer.empty();
        buildPaginationUI(
            paginationContainer,
            tableState.rawLimit!,
            tableState.page,
            totalRows,
            (newPage) => {
                tableState.page = newPage;
                void renderPage();
            },
            (newLimit) => {
                tableState.rawLimit = newLimit;
                tableState.page = 0;
                void renderPage();
            }
        );

        activePageChild.load();
    };

    void renderPage();
}
function showFilterPopup(
    e: MouseEvent,
    colName: string,
    currentFilter: { condition: string; values: string[] } | undefined,
    getUniqueValues: (col: string) => string[],
    onApply: (condition: string, values: string[]) => void
) {
    activeDocument.querySelectorAll(".sqlite-filter-popup").forEach((p) => p.remove());

    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();

    const popup = activeDocument.body.createDiv({ cls: "sqlite-filter-popup" }) as PopupElement;
    popup.setAttribute("data-col", colName);
    popup.setCssStyles({
        position: "absolute",
        top: `${rect.bottom + 8}px`,
        left: `${rect.left}px`,
        zIndex: "1000",
        opacity: "0",
    });

    const cleanupAndClose = () => {
        popup.remove();
        activeDocument.removeEventListener("mousedown", outsideClickListener);
        window.removeEventListener("scroll", scrollListener, true);
    };

    // EXPOSE the cleanup function so the button can trigger it properly
    popup.closePopup = cleanupAndClose;

    const outsideClickListener = (evt: MouseEvent) => {
        // Ignore the click if it landed on any filter button.
        // Let the button's own onclick event handle the logic.
        if (evt.target instanceof Element && evt.target.closest(".sqlite-filter-btn")) return;

        if (!popup.contains(evt.target as Node) && evt.target !== target) cleanupAndClose();
    };

    const scrollListener = (evt: Event) => {
        if (popup.contains(evt.target as Node)) return;
        cleanupAndClose();
    };

    window.setTimeout(() => {
        activeDocument.addEventListener("mousedown", outsideClickListener);
        window.addEventListener("scroll", scrollListener, true);
    }, 10);

    const headerRow = popup.createDiv({ cls: "sqlite-filter-header" });
    headerRow.createSpan({ text: `Filter: ${colName}` });

    const helpIcon = headerRow.createSpan({ cls: "sqlite-filter-help" });
    applyIcon(helpIcon, "help-circle");

    const helpText = popup.createDiv({ cls: "sqlite-filter-help-text" });
    helpText.appendChild(
        sanitizeHTMLToDom(
            `<strong>Math:</strong> <code>>=10</code>, <code><=100</code>, <code>!=5</code>, <code>=0</code><br><strong>Text:</strong> Exact (<code>=apple</code>) or Partial (<code>apple</code>)`
        )
    );

    helpIcon.onclick = (evt) => {
        evt.stopPropagation();
        helpText.classList.toggle("is-visible");
    };

    const condInput = popup.createEl("input", {
        type: "text",
        placeholder: "Search or >10, =abc...",
        cls: "sqlite-filter-input",
    });
    condInput.value = currentFilter?.condition || "";

    // Preview with fast render
    condInput.addEventListener("input", (e) => {
        const rawVal = (e.target as HTMLInputElement).value.trim().toLowerCase();

        // If the user is typing a math condition (e.g., ">= 10"), strip the operator
        // so the live preview searches the checklist for the actual value ("10").
        const match = rawVal.match(/^(?:>=|<=|>|<|!=|=)\s*(.*)$/);
        const searchStr = match ? match[1] : rawVal;

        // Iterate through the DOM nodes and hide/show them instantly
        const labels = checkboxContainer.querySelectorAll("label");
        labels.forEach((label) => {
            const text = label.textContent?.toLowerCase() || "";
            if (text.includes(searchStr)) {
                label.setCssStyles({ display: "flex" });
            } else {
                label.setCssStyles({ display: "none" });
            }
        });
    });

    const listContainer = popup.createDiv({ cls: "sqlite-filter-list" });
    const uniqueValues = getUniqueValues(colName);
    const selectedValues = new Set(currentFilter?.values || []);

    const actions = listContainer.createDiv({ cls: "sqlite-filter-list-actions" });
    const selectAllBtn = actions.createSpan({ text: "Select All" });
    const clearAllBtn = actions.createSpan({ text: "Clear All" });

    const checkboxContainer = listContainer.createDiv({ cls: "sqlite-filter-checkboxes" });

    const renderCheckboxes = () => {
        checkboxContainer.empty();
        uniqueValues.forEach((val) => {
            const label = checkboxContainer.createEl("label");
            const cb = label.createEl("input", { type: "checkbox" });
            cb.checked = selectedValues.has(val);
            cb.onchange = (e) => {
                if ((e.target as HTMLInputElement).checked) selectedValues.add(val);
                else selectedValues.delete(val);
            };
            label.createSpan({ text: val });
        });
    };
    renderCheckboxes();

    selectAllBtn.onclick = () => {
        uniqueValues.forEach((v) => selectedValues.add(v));
        renderCheckboxes();
    };
    clearAllBtn.onclick = () => {
        selectedValues.clear();
        renderCheckboxes();
    };

    const footer = popup.createDiv({ cls: "sqlite-filter-footer" });

    const clearBtn = footer.createEl("button", { text: "Clear", cls: "sqlite-filter-btn-clear" });
    clearBtn.onclick = () => {
        onApply("", []);
        cleanupAndClose();
    };

    const applyBtn = footer.createEl("button", { text: "Apply", cls: "sqlite-filter-btn-apply" });
    const applyLogic = () => {
        onApply(condInput.value.trim(), Array.from(selectedValues));
        cleanupAndClose();
    };
    applyBtn.onclick = applyLogic;

    // Catch Enter key on the popup container during the capture phase
    // so Obsidian's editor hotkeys don't steal the input
    popup.addEventListener(
        "keydown",
        (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                applyLogic();
            }
        },
        { capture: true }
    );

    window.setTimeout(() => {
        const pRect = popup.getBoundingClientRect();
        if (pRect.right > window.innerWidth) {
            popup.setCssStyles({ left: "auto", right: `${window.innerWidth - rect.right}px` });
        }
        if (pRect.bottom > window.innerHeight) {
            popup.setCssStyles({ top: "auto", bottom: `${window.innerHeight - rect.top + 8}px`, opacity: "1" });
        }
        popup.setCssStyles({ opacity: "1" });
        condInput.focus();
    }, 0);
}
