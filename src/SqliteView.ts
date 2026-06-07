import { FileView, WorkspaceLeaf, TFile, Notice, Scope, sanitizeHTMLToDom } from "obsidian";
import type { Database, SqlValue } from "sql.js";
import { ConfirmModal, CreateTableModal, RenameTableModal } from "./modals";
import { SqliteResultRenderer } from "./renderer";
import type ObsidianSqlitePlugin from "./main";
import { applyIcon, loadDb, createActionBtn } from "./utils";
import {
    highlightSqlSyntax,
    generateCascadeQueries,
    getDatabaseStats,
    getSidebarObjects,
    getTableThemeClass,
} from "./formatters";

export const VIEW_TYPE_SQLITE = "sqlite-view";

export class SqliteView extends FileView {
    db: Database | null = null;
    mainArea!: HTMLElement;
    fileObj!: TFile;
    activeTable: string = "";

    terminalQuery: string = "";
    isEditMode: boolean = false;
    visibleColumns: string[] = [];

    constructor(
        leaf: WorkspaceLeaf,
        private plugin: ObsidianSqlitePlugin
    ) {
        super(leaf);
    }

    getViewType() {
        return VIEW_TYPE_SQLITE;
    }
    getDisplayText() {
        return this.file ? this.file.name : "SQLite Dashboard";
    }
    getIcon() {
        return "database";
    }

    cleanupDatabase() {
        this.contentEl.empty();
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    async saveDatabase() {
        if (!this.db || !this.fileObj) return;
        try {
            const buffer = this.db.export().buffer;
            await this.app.vault.modifyBinary(this.fileObj, buffer as ArrayBuffer);
        } catch (e) {
            new Notice(`Save error: ${String(e)}`);
        }
    }

    private getViews(): { name: string; sql: string }[] {
        if (!this.db) return [];
        const viewData = this.db.exec("SELECT name, sql FROM sqlite_master WHERE type='view'");
        return viewData.length > 0
            ? viewData[0].values.map((r: SqlValue[]) => ({ name: String(r[0]), sql: String(r[1]) }))
            : [];
    }

    executeGlobalQuery(query: string, resultContainer?: HTMLElement) {
        if (!query || !this.db) return;
        try {
            const results = this.db.exec(query);
            void this.saveDatabase();

            if (resultContainer) {
                resultContainer.empty();

                if (results.length === 0) {
                    const modified = this.db.getRowsModified();
                    const msg = `✅ Query executed successfully! Rows affected: ${modified}`;
                    new Notice(msg);
                    resultContainer.createEl("div", { text: msg, cls: "sqlite-success" });
                } else {
                    results.forEach((res, index) => {
                        const gridWrapper = resultContainer.createEl("div", { cls: "sqlite-table-wrapper" });
                        gridWrapper.setCssStyles({ marginBottom: "20px" });

                        if (results.length > 1) {
                            gridWrapper
                                .createEl("div", {
                                    text: `Result ${index + 1}:`,
                                    cls: "text-muted",
                                })
                                .setCssStyles({ marginBottom: "5px" });
                        }

                        const styleType = this.plugin.settings.tableStyle || "default";
                        const tableCls = getTableThemeClass(styleType);

                        const grid = gridWrapper.createEl("table", { cls: tableCls });
                        grid.setCssStyles({
                            borderCollapse: "collapse",
                            borderSpacing: "0",
                            width: "100%",
                        });

                        const thead = grid.createEl("thead").createEl("tr");
                        res.columns.forEach((col) => {
                            const th = thead.createEl("th", { text: col });
                            th.classList.add("sqlite-query-result-th");
                        });

                        const tbody = grid.createEl("tbody");
                        res.values.forEach((row: SqlValue[]) => {
                            const tr = tbody.createEl("tr");
                            row.forEach((val) => {
                                const displayVal = val !== null ? String(val) : "NULL";
                                const td = tr.createEl("td", { text: displayVal });
                                td.title = displayVal;
                                td.classList.add("sqlite-query-result-td");
                            });
                        });
                    });
                }
            }

            if (/CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|WITH/i.test(query)) {
                this.renderLayout();
            }
        } catch (e) {
            if (resultContainer) {
                resultContainer.empty();
                resultContainer.createEl("div", { text: `SQL Error: ${String(e)}`, cls: "sqlite-error" });
            } else {
                new Notice(`Error: ${String(e)}`);
            }
        }
    }

    async onLoadFile(file: TFile) {
        this.fileObj = file;
        this.cleanupDatabase();

        this.activeTable = "";
        this.visibleColumns = [];
        this.terminalQuery = "";
        this.isEditMode = false;

        window.setTimeout(async () => {
            try {
                this.db = await loadDb(this.app, this.plugin.manifest.id, file);

                this.contentEl.setCssStyles({
                    display: "flex",
                    height: "100%",
                    padding: "0",
                });

                this.renderLayout();
            } catch (e) {
                new Notice(`Database load error: ${String(e)}`);
            }
        }, 50);
    }

    renderLayout() {
        this.contentEl.empty();
        if (!this.db) return;

        const sidebar = this.contentEl.createEl("div", { cls: "sqlite-sidebar" });

        const topBtns = sidebar.createEl("div", { cls: "sqlite-top-buttons" });

        const homeBtn = topBtns.createEl("button", { cls: "sqlite-sidebar-btn sqlite-btn-dashboard" });
        applyIcon(homeBtn.createSpan(), "layout-dashboard");
        homeBtn.createSpan({ text: "Dashboard" });
        homeBtn.onclick = () => {
            this.activeTable = "";
            this.visibleColumns = [];
            this.renderDashboard(null);
        };

        const createBtn = topBtns.createEl("button", { cls: "sqlite-sidebar-btn sqlite-btn-new" });
        applyIcon(createBtn.createSpan(), "plus-circle");
        createBtn.createSpan({ text: "New Table" });
        createBtn.onclick = () => {
            new CreateTableModal(this.app, (sql) => this.executeGlobalQuery(sql)).open();
        };

        const refreshBtn = topBtns.createEl("button", { cls: "sqlite-sidebar-btn sqlite-btn-refresh" });
        applyIcon(refreshBtn.createSpan(), "refresh-cw");
        refreshBtn.createSpan({ text: "Refresh" });
        refreshBtn.onclick = () => {
            this.refreshDatabase();
        };

        sidebar.createEl("div", { cls: "sqlite-sidebar-section", text: "Tables" });

        const tableList = sidebar.createEl("ul", { cls: "sqlite-nav-list" });
        tableList.setCssStyles({
            listStyle: "none",
            padding: "0",
            margin: "0",
        });

        const viewSection = sidebar.createEl("div", { cls: "sqlite-sidebar-section", text: "Views" });
        const viewList = sidebar.createEl("ul", { cls: "sqlite-nav-list" });
        viewList.setCssStyles({
            listStyle: "none",
            padding: "0",
            margin: "0",
        });

        this.mainArea = this.contentEl.createEl("div", { cls: "sqlite-main-area" });
        this.mainArea.setCssStyles({
            flex: "1",
            display: "flex",
            flexDirection: "column",
            overflow: "auto",
            padding: "20px",
        });

        let hasViews = false;
        const objects = getSidebarObjects(this.db);
        objects.forEach((obj) => {
            if (obj.type === "view") hasViews = true;

            const li = (obj.type === "table" ? tableList : viewList).createEl("li");
            li.textContent = obj.name;
            li.onmouseenter = () => li.setCssStyles({ backgroundColor: "var(--background-modifier-hover)" });
            li.onmouseleave = () => li.setCssStyles({ backgroundColor: "transparent" });
            li.onclick = () => {
                this.activeTable = obj.name;
                this.visibleColumns = [];
                this.renderDashboard(obj.name, obj.type);
            };
        });

        if (!hasViews) {
            viewSection.setCssStyles({ display: "none" });
            viewList.setCssStyles({ display: "none" });
        }

        this.renderDashboard(this.activeTable || null);
    }

    buildTerminal(container: HTMLElement, tableName: string | null) {
        const termWrapper = container.createEl("div", { cls: "sqlite-terminal-wrapper" });
        const header = termWrapper.createEl("div", { cls: "sqlite-terminal-header" });
        const snippetBar = header.createEl("div", { cls: "sqlite-snippet-bar" });
        const editorContainer = termWrapper.createEl("div", { cls: "sqlite-editor-container" });
        const highlightDiv = editorContainer.createEl("div", { cls: "sqlite-highlight" });
        const textarea = editorContainer.createEl("textarea");

        const updateHighlight = () => {
            highlightDiv.empty();
            highlightDiv.appendChild(sanitizeHTMLToDom(highlightSqlSyntax(textarea.value)));
        };

        textarea.value = this.terminalQuery;
        updateHighlight();

        const autoExpand = () => {
            textarea.setCssStyles({ height: "auto" });
            highlightDiv.setCssStyles({ height: "auto" });
            const newHeight = Math.max(140, textarea.scrollHeight);
            textarea.setCssStyles({ height: "100%" });
            highlightDiv.setCssStyles({ height: "100%" });
            editorContainer.setCssStyles({ height: newHeight + "px" });
        };

        window.setTimeout(autoExpand, 10);

        textarea.addEventListener("input", () => {
            this.terminalQuery = textarea.value;
            updateHighlight();
            autoExpand();
        });

        textarea.addEventListener("scroll", () => {
            highlightDiv.scrollTop = textarea.scrollTop;
            highlightDiv.scrollLeft = textarea.scrollLeft;
        });

        const safeTable = tableName || "table_name";
        const addSnippet = (label: string, query: string) => {
            const btn = snippetBar.createEl("button", { text: label, cls: "sqlite-snippet-btn" });
            btn.onclick = () => {
                textarea.value = query;
                this.terminalQuery = query;
                updateHighlight();
                textarea.focus();
            };
        };

        addSnippet("SELECT", `SELECT * FROM "${safeTable}" LIMIT 100;`);
        addSnippet("INSERT", `INSERT INTO "${safeTable}" (col1) VALUES ('value');`);
        addSnippet("UPDATE", `UPDATE "${safeTable}" SET col1 = 'value' WHERE id = 1;`);
        addSnippet("DELETE", `DELETE FROM "${safeTable}" WHERE id = 1;`);
        addSnippet("CREATE VIEW", `CREATE VIEW "new_view" AS\nSELECT * FROM "${safeTable}";`);

        const controls = termWrapper.createEl("div", { cls: "sqlite-terminal-controls" });
        const resultContainer = termWrapper.createEl("div", { cls: "sqlite-terminal-result" });

        let clearBtn: HTMLButtonElement;

        const runCurrentQuery = () => {
            this.executeGlobalQuery(textarea.value.trim(), resultContainer);
            if (clearBtn) clearBtn.setCssStyles({ display: "flex" });
        };

        createActionBtn(controls, "play", "Execute", runCurrentQuery);
        clearBtn = createActionBtn(controls, "eraser", "Clear", () => {
            resultContainer.empty();
            clearBtn.setCssStyles({ display: "none" });
        });
        clearBtn.setCssStyles({ display: "none" });

        const terminalScope = new Scope(this.app.scope);
        terminalScope.register(["Mod"], "Enter", (evt) => {
            evt.preventDefault();
            runCurrentQuery();
            return false;
        });

        textarea.addEventListener("focus", () => this.app.keymap.pushScope(terminalScope));
        textarea.addEventListener("blur", () => this.app.keymap.popScope(terminalScope));

        textarea.addEventListener("keydown", (e) => {
            if (e.key === "Tab") {
                e.preventDefault();
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                textarea.value = textarea.value.substring(0, start) + "    " + textarea.value.substring(end);
                textarea.selectionStart = textarea.selectionEnd = start + 4;
                this.terminalQuery = textarea.value;
                updateHighlight();
            }
        });
    }

    renderDashboard(tableName: string | null, type: string = "table") {
        this.mainArea.empty();
        if (!this.db) return;

        if (!tableName) {
            const dashHeader = this.mainArea.createEl("h2");
            dashHeader.setCssStyles({
                display: "flex",
                alignItems: "center",
                gap: "6px",
            });
            applyIcon(dashHeader.createSpan(), "database");
            dashHeader.createSpan({ text: ` Database: ${this.fileObj.name}` });

            const statsGrid = this.mainArea.createEl("div", { cls: "sqlite-stats-grid" });

            const addStatCard = (title: string, value: string) => {
                const card = statsGrid.createEl("div", { cls: "sqlite-stat-card" });
                card.createEl("div", { text: title, cls: "text-muted" }).setCssStyles({ marginBottom: "5px" });
                card.createEl("div", { text: value, cls: "sqlite-stat-value" });
            };

            try {
                const sizeKB = (this.fileObj.stat.size / 1024).toFixed(2);
                const { tableCount, viewCount } = getDatabaseStats(this.db);
                addStatCard("File size", `${sizeKB} KB`);
                addStatCard("Tables", String(tableCount));
                addStatCard("Views", String(viewCount));
            } catch (e) {
                new Notice(`Error: ${String(e)}`);
            }

            this.buildTerminal(this.mainArea, null);
            return;
        }

        let rowCount = 0;
        try {
            const countRes = this.db.exec(`SELECT COUNT(*) FROM "${tableName}";`);
            if (countRes.length && countRes[0].values.length) {
                rowCount = Number(countRes[0].values[0][0]);
            }
        } catch (e) {
            new Notice(`Error: ${String(e)}`);
        }

        const schema = this.db.exec(`PRAGMA table_info("${tableName}");`);
        const columnsInfo = schema.length > 0 ? schema[0].values : [];

        const header = this.mainArea.createEl("div", { cls: "sqlite-dashboard-header" });
        const titleArea = header.createEl("div", { cls: "sqlite-title-area" });

        titleArea.createEl("h2", { text: tableName, cls: "mod-margin-bottom-none" });

        createActionBtn(titleArea, "edit", "Rename", () => {
            new RenameTableModal(this.app, tableName, (newName) => {
                this.activeTable = newName;

                if (type === "table") {
                    const queries = generateCascadeQueries("RENAME", tableName, this.getViews(), newName);
                    this.executeGlobalQuery(queries);
                } else {
                    const viewMeta = this.db!.exec(
                        `SELECT sql FROM sqlite_master WHERE type='view' AND name='${tableName}'`
                    );
                    if (viewMeta.length && viewMeta[0].values.length) {
                        const sql = String(viewMeta[0].values[0][0]);
                        const regex = new RegExp(`(CREATE\\s+VIEW\\s+)["'\`\\[]?${tableName}["'\`\\]]?(\\s+AS)`, "i");
                        const newSql = sql.replace(regex, `$1"${newName}"$2`);
                        this.executeGlobalQuery(`DROP VIEW "${tableName}";\n${newSql}`);
                    }
                }
            }).open();
        });

        createActionBtn(titleArea, "trash", "Drop", () => {
            const label = type === "table" ? "table" : "view";
            new ConfirmModal(
                this.app,
                `Delete`,
                `Are you sure you want to permanently delete the ${label} "${tableName}"?`,
                () => {
                    this.activeTable = "";

                    if (type === "table") {
                        const queries = generateCascadeQueries("DROP", tableName, this.getViews());
                        this.executeGlobalQuery(queries);
                    } else {
                        this.executeGlobalQuery(`DROP VIEW "${tableName}";`);
                    }
                }
            ).open();
        });

        const stats = titleArea.createEl("div", { cls: "sqlite-table-stats" });
        stats.createEl("span", { text: type.toUpperCase() });
        stats.createEl("span", { text: `${rowCount} rows` });
        stats.createEl("span", { text: `${columnsInfo.length} cols` });

        this.buildTerminal(this.mainArea, tableName);

        const schemaHeader = this.mainArea.createEl("div", { cls: "sqlite-schema-header" });
        schemaHeader.createEl("span", { text: "Structure (Schema)", cls: "sqlite-schema-title" });

        const schemaIcon = schemaHeader.createEl("span");
        schemaIcon.setCssStyles({
            display: "flex",
            alignItems: "center",
            gap: "6px",
            transition: "transform 0.2s",
        });
        applyIcon(schemaIcon, "chevron-down");

        const schemaContent = this.mainArea.createEl("div");
        schemaContent.setCssStyles({ display: "none" });

        schemaHeader.onclick = () => {
            const isHidden = schemaContent.style.display === "none";
            schemaContent.setCssStyles({ display: isHidden ? "block" : "none" });

            if (isHidden) {
                schemaIcon.setCssStyles({ transform: "rotate(180deg)" });
                schemaHeader.classList.add("is-open");
            } else {
                schemaIcon.setCssStyles({ transform: "rotate(0deg)" });
                schemaHeader.classList.remove("is-open");
            }
        };

        const schemaTable = schemaContent.createEl("table", { cls: "sqlite-schema-table" });
        schemaTable.setCssStyles({
            width: "100%",
            borderCollapse: "collapse",
            marginBottom: "25px",
        });

        const trHead = schemaTable.createEl("thead").createEl("tr");
        ["Column Name", "Type", "Not Null"].forEach((txt) => {
            const th = trHead.createEl("th", { text: txt });
            th.classList.add("sqlite-schema-th");
        });

        const sBody = schemaTable.createEl("tbody");
        columnsInfo.forEach((col: SqlValue[]) => {
            const tr = sBody.createEl("tr");
            const nameTd = tr.createEl("td");
            const typeTd = tr.createEl("td");
            const nullTd = tr.createEl("td");
            nameTd.classList.add("sqlite-schema-td");
            typeTd.classList.add("sqlite-schema-td");
            nullTd.classList.add("sqlite-schema-td");

            if (col[5]) {
                nameTd.createEl("strong", { text: String(col[1]) });
                const pkSpan = nameTd.createSpan({ text: "🔑", title: "Primary Key" });
                pkSpan.setCssStyles({ color: "var(--text-warning)", fontSize: "14px", marginLeft: "5px" });
            } else {
                nameTd.textContent = String(col[1]);
            }

            const typeSpan = typeTd.createSpan({ text: String(col[2]) });
            typeSpan.setCssStyles({ color: "var(--text-muted)", fontFamily: "monospace" });

            nullTd.textContent = col[3] ? "Yes" : "No";
        });

        const dataHeader = this.mainArea.createEl("div", { cls: "sqlite-data-header" });
        const colBar = dataHeader.createEl("div", { cls: "sqlite-col-bar" });

        if (this.visibleColumns.length === 0) {
            this.visibleColumns = columnsInfo.map((c: SqlValue[]) => String(c[1]));
        }

        columnsInfo.forEach((c: SqlValue[]) => {
            const colName = String(c[1]);
            const isVisible = this.visibleColumns.includes(colName);

            const pill = colBar.createEl("span", {
                text: colName,
                cls: isVisible ? "sqlite-col-pill sqlite-col-pill-visible" : "sqlite-col-pill sqlite-col-pill-hidden",
            });

            pill.onclick = () => {
                if (isVisible) {
                    this.visibleColumns = this.visibleColumns.filter((vc) => vc !== colName);
                } else {
                    this.visibleColumns.push(colName);
                }
                this.visibleColumns.sort(
                    (a, b) =>
                        columnsInfo.findIndex((cl: SqlValue[]) => cl[1] === a) -
                        columnsInfo.findIndex((cl: SqlValue[]) => cl[1] === b)
                );
                this.renderDashboard(tableName, type);
            };
        });

        // Wrap actions in a dedicated layout container to prevent center drift
        const actionsGroup = dataHeader.createEl("div", { cls: "sqlite-header-actions" });
        const editModeBtn = actionsGroup.createEl("span", { cls: "sqlite-icon-btn sqlite-action" });
        applyIcon(editModeBtn, "pencil");
        editModeBtn.title = "Toggle Edit Mode (Live)";

        if (type === "view") {
            editModeBtn.setCssStyles({ display: "none" });
            this.isEditMode = false;
        }

        const updatePencilState = () => {
            if (this.isEditMode) {
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
        };
        updatePencilState();

        editModeBtn.onmouseenter = () => {
            if (!this.isEditMode) editModeBtn.setCssStyles({ opacity: "0.8" });
        };
        editModeBtn.onmouseleave = () => {
            if (!this.isEditMode) editModeBtn.setCssStyles({ opacity: "0.5" });
        };

        const copyMdBtn = actionsGroup.createEl("span", { cls: "sqlite-icon-btn sqlite-action" });
        applyIcon(copyMdBtn, "clipboard-copy");
        copyMdBtn.title = "Copy view as Markdown Table";
        copyMdBtn.onclick = (e) => {
            e.stopPropagation();
            if (currentRenderer) {
                void currentRenderer.copyToClipboard();
                // Apply the full glow effect
                copyMdBtn.setCssStyles({
                    opacity: "1",
                    color: "var(--interactive-accent)",
                    filter: "drop-shadow(0 0 5px var(--interactive-accent))",
                });

                // Revert back to normal after 250ms
                window.setTimeout(
                    () =>
                        copyMdBtn.setCssStyles({
                            opacity: "0.5",
                            color: "inherit",
                            filter: "none",
                        }),
                    250
                );
            }
        };

        const dataContainer = this.mainArea.createEl("div");
        let currentRenderer: SqliteResultRenderer | null = null;

        const renderData = () => {
            dataContainer.empty();
            if (currentRenderer) {
                this.removeChild(currentRenderer);
                currentRenderer.unload();
            }

            const selectedCols =
                this.visibleColumns.length > 0 ? this.visibleColumns.map((c) => `"${c}"`).join(", ") : "*";
            const queryStr = `SELECT ${selectedCols} FROM "${tableName}"`;

            currentRenderer = new SqliteResultRenderer(
                dataContainer,
                this.plugin,
                queryStr,
                this.fileObj,
                false,
                this.db,
                async () => await this.saveDatabase()
            );

            currentRenderer.tableName = tableName;
            currentRenderer.isEditMode = this.isEditMode;

            this.addChild(currentRenderer);
        };

        editModeBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.isEditMode = !this.isEditMode;
            updatePencilState();
            renderData();
        };

        renderData();
    }

    refreshDatabase() {
        if (!this.fileObj) return;

        const prevTable = this.activeTable;
        const prevCols = [...this.visibleColumns];
        const prevQuery = this.terminalQuery;

        // Don't clean DOM until new DB ready
        void (async () => {
            try {
                // Load db in background and close only when ready
                const newDb = await loadDb(this.app, this.plugin.manifest.id, this.fileObj);
                if (this.db) {
                    this.db.close();
                }
                this.db = newDb;

                // Restore state and etc
                let tableExists = false;
                if (prevTable) {
                    const safeName = prevTable.replace(/"/g, '""');
                    const check = this.db.exec(`SELECT name FROM sqlite_master WHERE name="${safeName}"`);
                    tableExists = check.length > 0 && check[0].values.length > 0;
                }

                this.activeTable = tableExists ? prevTable : "";
                this.visibleColumns = tableExists ? prevCols : [];
                this.terminalQuery = prevQuery;

                // Rewrite DOM in 1 frame
                this.renderLayout();
                new Notice("Database refreshed!");
            } catch (e) {
                new Notice(`Database load error: ${String(e)}`);
            }
        })();
    }

    async onClose() {
        this.cleanupDatabase();
    }
}
