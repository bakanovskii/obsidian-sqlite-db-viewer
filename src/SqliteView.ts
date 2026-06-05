import { FileView, WorkspaceLeaf, TFile, Notice, Scope } from "obsidian";
import type { Database } from "sql.js";
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
            await this.app.vault.modifyBinary(this.fileObj, buffer as any);
        } catch (err) {
            new Notice(`Save error: ${err}`);
        }
    }

    private getViews(): { name: string; sql: string }[] {
        if (!this.db) return [];
        const viewData = this.db.exec("SELECT name, sql FROM sqlite_master WHERE type='view'");
        return viewData.length > 0
            ? viewData[0].values.map((r) => ({ name: r[0] as string, sql: r[1] as string }))
            : [];
    }

    executeGlobalQuery(query: string, resultContainer?: HTMLElement) {
        if (!query || !this.db) return;
        try {
            const results = this.db.exec(query);
            this.saveDatabase();

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
                        gridWrapper.style.marginBottom = "20px";

                        if (results.length > 1) {
                            gridWrapper.createEl("div", {
                                text: `Result ${index + 1}:`,
                                cls: "text-muted",
                            }).style.marginBottom = "5px";
                        }

                        const styleType = this.plugin.settings.tableStyle || "default";
                        const tableCls = getTableThemeClass(styleType);

                        const grid = gridWrapper.createEl("table", { cls: tableCls });
                        grid.style.borderCollapse = "collapse";
                        grid.style.borderSpacing = "0";
                        grid.style.width = "100%";

                        const thead = grid.createEl("thead").createEl("tr");
                        res.columns.forEach((col) => {
                            const th = thead.createEl("th", { text: col });
                            th.classList.add("sqlite-query-result-th");
                        });

                        const tbody = grid.createEl("tbody");
                        res.values.forEach((row) => {
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
                resultContainer.createEl("div", { text: `SQL Error: ${e}`, cls: "sqlite-error" });
            } else {
                new Notice(`Error: ${e}`);
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

        setTimeout(async () => {
            try {
                this.db = await loadDb(this.app, this.plugin.manifest.id, file);

                this.contentEl.style.display = "flex";
                this.contentEl.style.height = "100%";
                this.contentEl.style.padding = "0";

                this.renderLayout();
            } catch (e) {
                new Notice(`Database load error: ${e}`);
            }
        }, 50);
    }

    renderLayout() {
        this.contentEl.empty();

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
        tableList.style.listStyle = "none";
        tableList.style.padding = "0";
        tableList.style.margin = "0";

        const viewSection = sidebar.createEl("div", { cls: "sqlite-sidebar-section", text: "Views" });
        const viewList = sidebar.createEl("ul", { cls: "sqlite-nav-list" });
        viewList.style.listStyle = "none";
        viewList.style.padding = "0";
        viewList.style.margin = "0";

        this.mainArea = this.contentEl.createEl("div", { cls: "sqlite-main-area" });
        this.mainArea.style.flex = "1";
        this.mainArea.style.display = "flex";
        this.mainArea.style.flexDirection = "column";
        this.mainArea.style.overflow = "auto";
        this.mainArea.style.padding = "20px";

        let hasViews = false;
        const objects = getSidebarObjects(this.db);
        objects.forEach((obj) => {
            if (obj.type === "view") hasViews = true;

            const li = (obj.type === "table" ? tableList : viewList).createEl("li");
            li.textContent = obj.name;
            li.onmouseenter = () => (li.style.backgroundColor = "var(--background-modifier-hover)");
            li.onmouseleave = () => (li.style.backgroundColor = "transparent");
            li.onclick = () => {
                this.activeTable = obj.name;
                this.visibleColumns = [];
                this.renderDashboard(obj.name, obj.type);
            };
        });

        if (!hasViews) {
            viewSection.style.display = "none";
            viewList.style.display = "none";
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
            highlightDiv.innerHTML = highlightSqlSyntax(textarea.value);
        };

        textarea.value = this.terminalQuery;
        updateHighlight();

        const autoExpand = () => {
            textarea.style.height = "auto";
            highlightDiv.style.height = "auto";
            const newHeight = Math.max(140, textarea.scrollHeight);
            textarea.style.height = "100%";
            highlightDiv.style.height = "100%";
            editorContainer.style.height = newHeight + "px";
        };

        setTimeout(autoExpand, 10);

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

        // eslint-disable-next-line prefer-const
        let clearBtn: HTMLButtonElement;

        const runCurrentQuery = () => {
            this.executeGlobalQuery(textarea.value.trim(), resultContainer);
            if (clearBtn) clearBtn.style.display = "flex";
        };

        createActionBtn(controls, "play", "Execute", runCurrentQuery);
        clearBtn = createActionBtn(controls, "eraser", "Clear", () => {
            resultContainer.empty();
            clearBtn.style.display = "none";
        });
        clearBtn.style.display = "none";

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

        if (!tableName) {
            const dashHeader = this.mainArea.createEl("h2");
            dashHeader.style.display = "flex";
            dashHeader.style.alignItems = "center";
            dashHeader.style.gap = "6px";
            applyIcon(dashHeader.createSpan(), "database");
            dashHeader.createSpan({ text: ` Database: ${this.fileObj.name}` });

            const statsGrid = this.mainArea.createEl("div", { cls: "sqlite-stats-grid" });

            const addStatCard = (title: string, value: string) => {
                const card = statsGrid.createEl("div", { cls: "sqlite-stat-card" });
                card.createEl("div", { text: title, cls: "text-muted" }).style.marginBottom = "5px";
                card.createEl("div", { text: value, cls: "sqlite-stat-value" });
            };

            try {
                const sizeKB = (this.fileObj.stat.size / 1024).toFixed(2);
                const { tableCount, viewCount } = getDatabaseStats(this.db);
                addStatCard("File size", `${sizeKB} KB`);
                addStatCard("Tables", String(tableCount));
                addStatCard("Views", String(viewCount));
            } catch (e) {
                new Notice(`Error: ${e}`);
            }

            this.buildTerminal(this.mainArea, null);
            return;
        }

        let rowCount = 0;
        try {
            rowCount = this.db!.exec(`SELECT COUNT(*) FROM "${tableName}";`)[0].values[0][0] as number;
        } catch (e) {
            new Notice(`Error: ${e}`);
        }
        const schema = this.db!.exec(`PRAGMA table_info("${tableName}");`);
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
                        const sql = viewMeta[0].values[0][0] as string;
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
        schemaIcon.style.display = "flex";
        schemaIcon.style.alignItems = "center";
        schemaIcon.style.gap = "6px";
        applyIcon(schemaIcon, "chevron-down");
        schemaIcon.style.transition = "transform 0.2s";

        const schemaContent = this.mainArea.createEl("div");
        schemaContent.style.display = "none";

        schemaHeader.onclick = () => {
            const isHidden = schemaContent.style.display === "none";
            schemaContent.style.display = isHidden ? "block" : "none";

            if (isHidden) {
                schemaIcon.style.transform = "rotate(180deg)";
                schemaHeader.classList.add("is-open");
            } else {
                schemaIcon.style.transform = "rotate(0deg)";
                schemaHeader.classList.remove("is-open");
            }
        };

        const styleType = this.plugin.settings.tableStyle || "default";
        const tableCls = getTableThemeClass(styleType);

        const schemaTable = schemaContent.createEl("table", { cls: tableCls });
        schemaTable.style.width = "100%";
        schemaTable.style.borderCollapse = "collapse";
        schemaTable.style.marginBottom = "25px";

        const trHead = schemaTable.createEl("thead").createEl("tr");
        ["Column Name", "Type", "Not Null"].forEach((txt) => {
            const th = trHead.createEl("th", { text: txt });
            th.classList.add("sqlite-schema-th");
        });

        const sBody = schemaTable.createEl("tbody");
        columnsInfo.forEach((col) => {
            const tr = sBody.createEl("tr");
            const nameTd = tr.createEl("td");
            const typeTd = tr.createEl("td");
            const nullTd = tr.createEl("td");
            nameTd.classList.add("sqlite-schema-td");
            typeTd.classList.add("sqlite-schema-td");
            nullTd.classList.add("sqlite-schema-td");

            if (col[5]) {
                nameTd.innerHTML = `<strong>${col[1]}</strong> <span style="color: var(--text-warning); font-size: 14px; margin-left: 5px;" title="Primary Key">🔑</span>`;
            } else {
                nameTd.textContent = String(col[1]);
            }
            typeTd.innerHTML = `<span style="color: var(--text-muted); font-family: monospace;">${col[2]}</span>`;
            nullTd.textContent = col[3] ? "Yes" : "No";
        });

        const dataHeader = this.mainArea.createEl("div", { cls: "sqlite-data-header" });
        const colBar = dataHeader.createEl("div", { cls: "sqlite-col-bar" });

        if (this.visibleColumns.length === 0) {
            this.visibleColumns = columnsInfo.map((c) => c[1] as string);
        }

        columnsInfo.forEach((c) => {
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
                    (a, b) => columnsInfo.findIndex((c) => c[1] === a) - columnsInfo.findIndex((c) => c[1] === b)
                );
                this.renderDashboard(tableName, type);
            };
        });

        const editModeBtn = dataHeader.createEl("span", { cls: "sqlite-icon-btn sqlite-action" });
        applyIcon(editModeBtn, "pencil");
        editModeBtn.title = "Toggle Edit Mode (Live)";

        if (type === "view") {
            editModeBtn.style.display = "none";
            this.isEditMode = false;
        }

        const updatePencilState = () => {
            if (this.isEditMode) {
                editModeBtn.style.opacity = "1";
                editModeBtn.style.color = "var(--interactive-accent)";
                editModeBtn.style.filter = "drop-shadow(0 0 5px var(--interactive-accent))";
            } else {
                editModeBtn.style.opacity = "0.5";
                editModeBtn.style.color = "inherit";
                editModeBtn.style.filter = "none";
            }
        };
        updatePencilState();

        editModeBtn.onmouseenter = () => {
            if (!this.isEditMode) editModeBtn.style.opacity = "0.8";
        };
        editModeBtn.onmouseleave = () => {
            if (!this.isEditMode) editModeBtn.style.opacity = "0.5";
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

        // Save the user's current exact state before wiping
        const prevTable = this.activeTable;
        const prevCols = [...this.visibleColumns];
        const prevQuery = this.terminalQuery;

        // Drops the old DB memory
        this.cleanupDatabase();

        setTimeout(async () => {
            try {
                this.db = await loadDb(this.app, this.plugin.manifest.id, this.fileObj);

                this.contentEl.style.display = "flex";
                this.contentEl.style.height = "100%";
                this.contentEl.style.padding = "0";

                // Verify the table still exists (in case it was deleted externally)
                let tableExists = false;
                if (prevTable) {
                    const safeName = prevTable.replace(/"/g, '""');
                    const check = this.db.exec(`SELECT name FROM sqlite_master WHERE name="${safeName}"`);
                    tableExists = check.length > 0 && check[0].values.length > 0;
                }

                this.activeTable = tableExists ? prevTable : "";
                this.visibleColumns = tableExists ? prevCols : [];
                this.terminalQuery = prevQuery;

                this.renderLayout();
                new Notice("Database refreshed!");
            } catch (e) {
                new Notice(`Database load error: ${e}`);
            }
        }, 50);
    }

    async onClose() {
        this.cleanupDatabase();
    }
}
