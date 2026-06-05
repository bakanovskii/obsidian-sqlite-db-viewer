import {
    Plugin,
    WorkspaceLeaf,
    TFile,
    Notice,
    MarkdownPostProcessorContext,
    Editor,
    MarkdownView,
    MarkdownFileInfo,
    MarkdownRenderChild,
} from "obsidian";
import initSqlJs from "sql.js";
import { SqliteView, VIEW_TYPE_SQLITE } from "./SqliteView";
import {
    SQLITE_EXTENSIONS,
    SQLITE_CODE_BLOCK_ALIASES,
    SqlitePluginSettings,
    DEFAULT_SETTINGS,
    SqliteSettingTab,
    DOM_CLASSES,
    DOM_ATTRIBUTES,
} from "./config";
import { CreateDatabaseModal, ImportTableModal } from "./modals";
import { Prec } from "@codemirror/state";
import { SqliteResultRenderer, buildDbWindowUI } from "./renderer";
import { sqliteExtension } from "./editor-extension";
import { parseMarkdownTableRow, parseSqlCodeBlock, scanForMarkdownTable, getWrapperThemeClass } from "./formatters";
import { preventEventPropagation } from "./utils";

declare const activeDocument: Document;

const SELECTORS = {
    LIVE_PREVIEW: ".markdown-source-view.mod-cm6",
    EDIT_BLOCK_BTN: ".edit-block-button",
    DATA_HREF: "data-href",
} as const;

export default class ObsidianSqlitePlugin extends Plugin {
    declare settings: SqlitePluginSettings;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new SqliteSettingTab(this.app, this));

        this.registerView(VIEW_TYPE_SQLITE, (leaf: WorkspaceLeaf) => new SqliteView(leaf, this));
        this.registerExtensions(SQLITE_EXTENSIONS, VIEW_TYPE_SQLITE);

        this.addRibbonIcon("database", "Create SQLite DB", () => new CreateDatabaseModal(this.app, this).open());
        this.addCommand({
            id: "create-sqlite-db",
            name: "Create",
            callback: () => new CreateDatabaseModal(this.app, this).open(),
        });

        this.addCommand({
            id: "export-selected-table-to-sqlite",
            name: "Import selected table to SQLite DB",
            editorCallback: (editor: Editor, _ctx: MarkdownView | MarkdownFileInfo) => {
                this.triggerTableExport(editor);
            },
        });

        SQLITE_CODE_BLOCK_ALIASES.forEach((alias) => {
            this.registerMarkdownCodeBlockProcessor(alias, async (source, el, ctx) => {
                await this.processSqlCodeBlock(source, el, ctx.sourcePath, ctx);
            });
        });

        this.registerEditorExtension(Prec.highest(sqliteExtension(this)));
        this.registerMarkdownPostProcessors();
    }

    private registerMarkdownPostProcessors() {
        this.registerMarkdownPostProcessor((element, context) => {
            const isLivePreview = element.closest(SELECTORS.LIVE_PREVIEW) !== null;
            if (isLivePreview) return;

            const embeds = Array.from(element.querySelectorAll(DOM_CLASSES.EMBED_SELECTOR));
            if (element.matches(DOM_CLASSES.EMBED_SELECTOR)) embeds.push(element);

            embeds.forEach((el) => {
                const embed = el as HTMLElement;
                const filePath = embed.getAttribute(DOM_ATTRIBUTES.SRC) || embed.getAttribute(SELECTORS.DATA_HREF);
                const query = embed.getAttribute(DOM_ATTRIBUTES.ALT) || "";

                if (!filePath || !query.toUpperCase().includes("SELECT")) return;
                if (!SQLITE_EXTENSIONS.some((ext) => filePath.endsWith("." + ext))) return;
                if (embed.hasAttribute(DOM_ATTRIBUTES.PROCESSED)) return;

                embed.setAttribute(DOM_ATTRIBUTES.PROCESSED, "true");
                const file = this.app.metadataCache.getFirstLinkpathDest(filePath, context.sourcePath);
                if (!(file instanceof TFile)) return;

                const windowWrapper = activeDocument.createElement("div");
                const wrapperCls = getWrapperThemeClass(this.settings.tableStyle);
                if (wrapperCls) windowWrapper.classList.add(wrapperCls);

                let renderer: SqliteResultRenderer;

                const tableContainer = buildDbWindowUI(
                    windowWrapper,
                    filePath,
                    undefined,
                    (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        void this.app.workspace.getLeaf(true).openFile(file);
                    },
                    (isEdit: boolean) => {
                        if (renderer) renderer.setEditMode(isEdit);
                    },
                    (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        if (renderer) void renderer.refresh();
                    }
                );

                embed.replaceWith(windowWrapper);

                renderer = new SqliteResultRenderer(tableContainer, this, query, file);
                context.addChild(renderer);
            });
        });
    }

    triggerTableExport(editor: Editor) {
        const lines = scanForMarkdownTable(
            editor.lineCount(),
            (i) => editor.getLine(i),
            editor.getCursor("from").line,
            editor.getCursor("to").line,
            editor.somethingSelected()
        );

        if (lines.length < 3) {
            new Notice("Table is too small or could not be found near cursor.");
            return;
        }

        const headers = parseMarkdownTableRow(lines[0]);
        const rows = [];

        for (let i = 2; i < lines.length; i++) {
            rows.push(parseMarkdownTableRow(lines[i]));
        }

        new ImportTableModal(this.app, this, headers, rows).open();
    }

    async createNewDatabase(fileName: string) {
        if (this.app.vault.getAbstractFileByPath(fileName)) {
            new Notice(`File ${fileName} already exists!`);
            return;
        }

        try {
            const configDir = this.app.vault.configDir;
            const pluginDir = this.manifest.dir || `${configDir}/plugins/${this.manifest.id}`;
            const wasmPath = `${pluginDir}/sql-wasm.wasm`;

            const wasmBuffer = await this.app.vault.adapter.readBinary(wasmPath);
            const SQL = await initSqlJs({
                wasmBinary: wasmBuffer,
            });

            const db = new SQL.Database();
            const buffer = db.export().buffer;
            const file = await this.app.vault.createBinary(fileName, buffer as ArrayBuffer);

            new Notice(`Database ${fileName} created successfully!`);

            const leaf = this.app.workspace.getLeaf(true);
            void leaf.openFile(file);
        } catch (e) {
            new Notice(`Error creating DB: ${String(e)}`);
        }
    }

    async processSqlCodeBlock(source: string, el: HTMLElement, sourcePath: string, ctx: MarkdownPostProcessorContext) {
        const renderChild = new MarkdownRenderChild(el);
        ctx.addChild(renderChild);

        const isLivePreview = el.closest(SELECTORS.LIVE_PREVIEW) !== null;
        if (isLivePreview && !this.settings.renderInLivePreview) {
            const pre = el.createEl("pre");
            pre.createEl("code", { text: source, cls: "language-sqlite" });
            return;
        }

        const { dbPath, query } = parseSqlCodeBlock(source);
        const file = this.app.metadataCache.getFirstLinkpathDest(dbPath, sourcePath);

        if (!dbPath || !(file instanceof TFile)) {
            el.createEl("span", { text: `Error: DB not found -> ${dbPath}`, cls: "error" });
            return;
        }

        const windowWrapper = el.createEl("div");
        const preBlock = el.closest("pre");
        if (preBlock) {
            preBlock.setCssStyles({ margin: "0", padding: "0" });
        }

        const wrapperCls = getWrapperThemeClass(this.settings.tableStyle);
        if (wrapperCls) windowWrapper.classList.add(wrapperCls);
        preventEventPropagation(windowWrapper);

        let renderer: SqliteResultRenderer;

        const tableContainer = buildDbWindowUI(
            windowWrapper,
            file.name,
            (e) => {
                e.preventDefault();
                e.stopPropagation();
                const nativeBtn = el.parentElement?.querySelector(SELECTORS.EDIT_BLOCK_BTN) as HTMLElement;
                if (nativeBtn) nativeBtn.click();
                else el.click();
            },
            (e) => {
                e.preventDefault();
                e.stopPropagation();
                void this.app.workspace.getLeaf(true).openFile(file);
            },
            (isEdit: boolean) => {
                if (renderer) renderer.setEditMode(isEdit);
            },
            (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (renderer) void renderer.refresh();
            }
        );

        try {
            renderer = new SqliteResultRenderer(tableContainer, this, query, file, false);
            renderChild.addChild(renderer);
            renderer.load();
        } catch (e) {
            tableContainer.createEl("span", { text: `SQL Error: ${String(e)}`, cls: "sqlite-error" });
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as SqlitePluginSettings;
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}
