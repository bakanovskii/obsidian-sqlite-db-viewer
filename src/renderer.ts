import { MarkdownRenderChild, TFile, MarkdownRenderer, Notice } from "obsidian";
import { PAGINATION_NUMS } from "./config";
import { applyIcon, loadDb, createActionBtn } from "./utils";
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
} from "./formatters";

export class SqliteResultRenderer extends MarkdownRenderChild {
    isEditMode: boolean = false;
    tableName: string | null = null;
    pkColumn: any = null;
    columnsInfo: any[] = [];

    // Local DB connection for Codeblocks
    localDb: any = null;
    get activeDb() {
        return this.sharedDb || this.localDb;
    }

    lastDbResult: { columns: string[]; totalRows: number } | null = null;
    tableState: { page: number; rawLimit?: number; sortCol?: string; sortDir?: "ASC" | "DESC" | null } = { page: 0 };
    jumpToLastPage: boolean = false;

    toolbarEl!: HTMLElement;
    tableEl!: HTMLElement;

    constructor(
        containerEl: HTMLElement,
        private plugin: ObsidianSqlitePlugin,
        private query: string,
        private file: TFile,
        private forceRaw: boolean = false,
        private sharedDb: any = null,
        private onDbModified: () => Promise<void> = async () => {}
    ) {
        super(containerEl);
    }

    async onload() {
        if (!this.sharedDb) {
            this.localDb = await loadDb(this.plugin.app, this.plugin.manifest.id, this.file);
        }
        this.containerEl.empty();
        this.toolbarEl = this.containerEl.createEl("div");
        this.tableEl = this.containerEl.createEl("div");
        await this.loadDataAndRender();
    }

    onunload() {
        if (this.localDb) {
            this.localDb.close();
            this.localDb = null;
        }
    }

    setEditMode(isEdit: boolean) {
        this.isEditMode = isEdit;
        if (this.lastDbResult) {
            this.renderTable();
        } else {
            this.loadDataAndRender();
        }
    }

    async refresh() {
        if (!this.sharedDb) {
            if (this.localDb) {
                this.localDb.close();
                this.localDb = null;
            }
            this.localDb = await loadDb(this.plugin.app, this.plugin.manifest.id, this.file);
        }
        this.lastDbResult = null;
        this.columnsInfo = [];
        this.tableName = null;
        this.tableState.page = 0;
        await this.loadDataAndRender();
        new Notice("Table refreshed!");
    }

    private async executeWrite(query: string, params: any[]) {
        const stmt = this.activeDb.prepare(query);
        stmt.run(params);
        stmt.free();

        if (this.sharedDb) {
            await this.onDbModified();
        } else {
            const buffer = this.activeDb.export().buffer;
            await this.plugin.app.vault.modifyBinary(this.file, buffer as any);
        }
    }

    async updateQuery(newQuery: string) {
        this.query = newQuery;
        this.lastDbResult = null;
        this.columnsInfo = [];
        this.tableName = null;
        this.tableState.page = 0;
        await this.loadDataAndRender();
    }

    async loadDataAndRender() {
        if (!this.lastDbResult) {
            this.toolbarEl.empty();
            this.tableEl.empty();
            this.tableEl.style.display = "block";
            this.tableEl.textContent = "⏳ Executing query...";
        }

        try {
            const db = this.activeDb;

            if (this.tableName === null && !this.forceRaw) {
                this.tableName = extractTableNameFromQuery(this.query);
            }

            if (this.tableName && this.columnsInfo.length === 0) {
                try {
                    const schema = db.exec(`PRAGMA table_info("${this.tableName}");`);
                    if (schema.length > 0) {
                        const { columns, pkColumnName } = parseTableSchema(schema[0].values);
                        this.columnsInfo = schema[0].values;
                        this.pkColumn = columns.find((c) => c.name === pkColumnName);
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
            const countQuery = buildCountQuery(this.query);
            if (countQuery) {
                try {
                    const countRes = db.exec(countQuery);
                    if (countRes.length > 0 && countRes[0].values.length > 0) {
                        totalRows = countRes[0].values[0][0] as number;
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
                    const warn = this.toolbarEl.createEl("div", {
                        text: "⚠️ Read-only: No Primary Key",
                        cls: "text-warning",
                    });
                    warn.style.fontSize = "12px";
                    warn.style.marginBottom = "10px";
                }

                this.lastDbResult = { columns, totalRows };
                this.renderTable();
            } else {
                this.tableEl.empty();
                this.tableEl.textContent = "[Query executed: no data]";
            }
        } catch (e) {
            this.tableEl.empty();
            this.tableEl.createEl("span", { text: `[SQL Error: ${e}]`, cls: "sqlite-error" });
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
                const paginatedQuery = buildPaginatedQuery(this.query, sortCol, sortDir, limit, offset);
                try {
                    const res = this.activeDb.exec(paginatedQuery);
                    return res.length > 0 ? res[0].values : [];
                } catch (e) {
                    new Notice(`Query error: ${e}`);
                    return [];
                }
            },
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
                    MarkdownRenderer.render(this.plugin.app, displayValue, td, this.file.path, cellComponent).then(
                        () => {
                            const p = td.querySelector("p");
                            if (p) {
                                p.style.margin = "0";
                                p.style.padding = "0";
                            }
                        }
                    );
                } else {
                    td.textContent = displayValue;

                    if (mode === "editable" && row && this.lastDbResult) {
                        const pkIndex = this.lastDbResult.columns.indexOf(this.pkColumn.name);
                        const rowPkValue = pkIndex !== -1 ? row[pkIndex] : null;

                        td.contentEditable = "true";
                        td.classList.add("sqlite-editable-cell");

                        td.onfocus = () => (td.style.backgroundColor = "var(--background-modifier-hover)");
                        td.onblur = async () => {
                            td.style.backgroundColor = "transparent";
                            const newVal = td.textContent;
                            if (newVal !== displayValue) {
                                const finalVal = newVal === "NULL" ? null : newVal;
                                const colIndex = this.lastDbResult!.columns.indexOf(colName!);
                                await this.updateCell(colName!, finalVal, rowPkValue, row, colIndex);
                            }
                        };
                        td.onkeydown = (e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                td.blur();
                            }
                        };
                    } else if (mode === "readonly" && this.isEditMode) {
                        td.style.backgroundColor = "var(--background-secondary)";
                        td.style.color = "var(--text-muted)";
                        td.style.cursor = "not-allowed";
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
                lastTd.style.position = "relative";

                const delBtn = lastTd.createEl("div", { cls: "sqlite-row-action" });
                applyIcon(delBtn, "trash");

                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    const pkIndex = this.lastDbResult!.columns.indexOf(this.pkColumn.name);
                    const pkValue = row[pkIndex];

                    new ConfirmModal(
                        this.plugin.app,
                        "Delete Row",
                        `Are you sure you want to delete this row? (${this.pkColumn.name} = ${pkValue})`,
                        async () => {
                            await this.deleteRow(pkValue);
                        }
                    ).open();
                };
            }
        );
    }

    async updateCell(colName: string, newVal: string | null, pkValue: any, row: any[], colIndex: number) {
        try {
            await this.executeWrite(
                `UPDATE "${this.tableName}" SET "${colName}" = ? WHERE "${this.pkColumn.name}" = ?`,
                [newVal, pkValue]
            );

            row[colIndex] = newVal;
            new Notice("Row updated!");
        } catch (e) {
            new Notice(`Update error: ${e}`);
            await this.loadDataAndRender();
        }
    }

    async deleteRow(pkValue: any) {
        try {
            await this.executeWrite(`DELETE FROM "${this.tableName}" WHERE "${this.pkColumn.name}" = ?`, [pkValue]);
            await this.loadDataAndRender();
            new Notice("Row deleted!");
        } catch (e) {
            new Notice(`Delete error: ${e}`);
        }
    }

    renderGhostRow(tbody: HTMLElement, colCount: number) {
        const tr = tbody.createEl("tr", { cls: "sqlite-ghost-row" });
        const td = tr.createEl("td");
        td.colSpan = colCount;

        const promptWrapper = td.createEl("div", { cls: "sqlite-ghost-prompt" });
        applyIcon(promptWrapper.createSpan(), "plus");
        promptWrapper.createSpan({ text: "New row..." });

        const formWrapper = td.createEl("div", { cls: "sqlite-ghost-form" });
        const inputs: Record<string, HTMLInputElement> = {};

        this.columnsInfo.forEach((colMeta) => {
            const colName = colMeta[1];
            const isPk = this.pkColumn && this.pkColumn.name === colName;
            const hasDefault = colMeta[4] !== null;
            const isAuto = isPk || hasDefault;

            const field = formWrapper.createEl("div", { cls: "sqlite-ghost-field" });
            field.createEl("label", { text: colName + (isAuto ? " (AUTO)" : "") });

            const inp = field.createEl("input", { type: "text" });
            if (isAuto) {
                inp.disabled = true;
                inp.placeholder = hasDefault ? "DEFAULT" : "AUTO";
            } else {
                inputs[colName] = inp;
            }
        });

        const btnGroup = formWrapper.createEl("div", { cls: "sqlite-ghost-btn-group" });

        const cancelBtn = btnGroup.createEl("button", { cls: "sqlite-action-btn" });
        cancelBtn.textContent = "Cancel";
        cancelBtn.onclick = (e) => {
            e.stopPropagation();
            formWrapper.style.display = "none";
            promptWrapper.style.display = "flex";
        };

        const saveNewBtn = createActionBtn(btnGroup, "save", "Save", async (e) => {
            e.stopPropagation();

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
            } catch (err) {
                new Notice(`Insertion error: ${err}`);
            }
        });
        saveNewBtn.classList.add("is-cta");

        promptWrapper.onclick = async (e) => {
            e.stopPropagation();

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
                promptWrapper.style.display = "none";
                formWrapper.style.display = "flex";
            }
        };
    }
}

export function buildDbWindowUI(
    wrapper: HTMLElement,
    titleText: string,
    onEdit?: (e: MouseEvent) => void,
    onOpenDb?: (e: MouseEvent) => void,
    onToggleEditMode?: (isEdit: boolean) => void,
    onRefresh?: (e: MouseEvent) => void
): HTMLElement {
    wrapper.classList.add("sqlite-db-window");

    const header = wrapper.createEl("div", { cls: "sqlite-db-header" });
    const titleContainer = header.createEl("div", { cls: "sqlite-db-title-container" });
    const dbIcon = titleContainer.createEl("span", { cls: "sqlite-db-icon" });
    applyIcon(dbIcon, "database");
    titleContainer.createEl("span", { text: titleText, cls: "sqlite-db-title" });

    const btnGroup = header.createEl("div", { cls: "sqlite-db-buttons sqlite-hide-in-reading" });

    if (onToggleEditMode) {
        const editModeBtn = btnGroup.createEl("span", { cls: "sqlite-icon-btn sqlite-action" });
        applyIcon(editModeBtn, "pencil");
        editModeBtn.title = "Toggle Edit Mode (Live)";

        let isEdit = false;
        editModeBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            isEdit = !isEdit;
            if (isEdit) {
                editModeBtn.style.opacity = "1";
                editModeBtn.style.color = "var(--interactive-accent)";
                editModeBtn.style.filter = "drop-shadow(0 0 5px var(--interactive-accent))";
            } else {
                editModeBtn.style.opacity = "0.5";
                editModeBtn.style.color = "inherit";
                editModeBtn.style.filter = "none";
            }
            onToggleEditMode(isEdit);
        };
        editModeBtn.onmouseenter = () => {
            if (!isEdit) editModeBtn.style.opacity = "0.8";
        };
        editModeBtn.onmouseleave = () => {
            if (!isEdit) editModeBtn.style.opacity = "0.5";
        };
    }

    if (onEdit) {
        const editBtn = btnGroup.createEl("span", { cls: "sqlite-icon-btn sqlite-action" });
        applyIcon(editBtn, "code");
        editBtn.title = "Edit code";
        editBtn.onclick = onEdit;
    }

    if (onRefresh) {
        const refreshBtn = btnGroup.createEl("span", { cls: "sqlite-icon-btn sqlite-action" });
        applyIcon(refreshBtn, "refresh-cw");
        refreshBtn.title = "Refresh Table";
        refreshBtn.onclick = onRefresh;
    }

    if (onOpenDb) {
        const openDbBtn = btnGroup.createEl("span", { cls: "sqlite-icon-btn sqlite-action" });
        applyIcon(openDbBtn, "database");
        openDbBtn.title = "Open DB Explorer";
        openDbBtn.onclick = onOpenDb;
    }

    const tableContainer = wrapper.createEl("div");
    tableContainer.style.padding = "10px";
    tableContainer.style.overflowX = "auto";
    tableContainer.style.userSelect = "text";

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
    const pageControls = container.createEl("div", { cls: "sqlite-pagination" });

    const limitSelector = pageControls.createEl("div", { cls: "sqlite-pagination-limit" });
    limitSelector.createEl("span", { text: "Rows: " });
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

    const nav = pageControls.createEl("div", { cls: "sqlite-pagination-nav" });
    const prevBtn = nav.createEl("button", { cls: "sqlite-pagination-btn", text: "◀" });
    prevBtn.disabled = currentPage === 0;
    prevBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (currentPage > 0) onPageChange(currentPage - 1);
    };

    const pageIndicator = nav.createEl("span", { cls: "sqlite-pagination-indicator" });
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
    tableState: { page: number; rawLimit?: number; sortCol?: string; sortDir?: "ASC" | "DESC" | null },
    tableStyle: string,
    fetchData: (limit: number, offset: number, sortCol?: string, sortDir?: "ASC" | "DESC" | null) => Promise<any[][]>,
    renderCell: (val: any, td: HTMLElement, cellComponent: MarkdownRenderChild, row?: any[], colName?: string) => void,
    renderGhostRow?: (tbody: HTMLElement, colCount: number) => void,
    renderRowAction?: (tr: HTMLElement, row: any[]) => void
) {
    if (tableState.rawLimit === undefined) {
        tableState.rawLimit = initialLimit;
    }

    let activePageChild: MarkdownRenderChild | null = null;

    container.empty();
    const wrapper = container.createEl("div", { cls: "sqlite-table-wrapper" });
    const tableCls = getTableThemeClass(tableStyle);

    const table = wrapper.createEl("table", { cls: tableCls });
    table.style.width = "100%";
    table.style.minWidth = "100%";
    table.style.borderCollapse = "collapse";
    table.style.borderSpacing = "0";

    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");

    columns.forEach((col: string) => {
        const th = headerRow.createEl("th");
        th.textContent = col;

        th.onclick = (e) => {
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
            renderPage();
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
    const paginationContainer = container.createEl("div");

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
        loadingTd.style.textAlign = "center";

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

        for (const row of pageValues) {
            const tr = tbody.createEl("tr");
            tr.style.position = "relative";

            row.forEach((val: any, index: number) => {
                const td = tr.createEl("td");
                const displayVal = val !== null ? String(val) : "NULL";
                td.title = displayVal;
                renderCell(val, td, activePageChild!, row, columns[index]);
            });

            if (renderRowAction) {
                renderRowAction(tr, row);
            }
        }

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
                renderPage();
            },
            (newLimit) => {
                tableState.rawLimit = newLimit;
                tableState.page = 0;
                renderPage();
            }
        );

        activePageChild.load();
    };

    renderPage();
}
