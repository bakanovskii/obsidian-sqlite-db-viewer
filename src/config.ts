import { App, PluginSettingTab, Setting } from "obsidian";
import type ObsidianSqlitePlugin from "./main";

export const PAGINATION_NUMS = [10, 50, 100, 500, 0];
export const SQLITE_EXTENSIONS = ["db", "sqlite", "sqlite3"];
export const SQLITE_CODE_BLOCK_ALIASES = ["db-query", "sqlite-query", "sqlite3-query"];

export const DOM_ATTRIBUTES = {
    PROCESSED: "data-sqlite-processed",
    QUERY: "data-sqlite-query",
    SRC: "src",
    ALT: "alt",
} as const;

export const DOM_CLASSES = {
    EMBED_SELECTOR: ".internal-embed",
    SQLITE_LIVE_EMBED: "sqlite-live-embed",
    FILE_EMBED: "file-embed",
    MARKDOWN_EMBED: "markdown-embed",
    IS_LOADED: "is-loaded",
} as const;

export interface SqlitePluginSettings {
    defaultRowLimit: number;
    renderInLivePreview: boolean;
    renderMarkdownInCells: boolean;
    tableStyle: string;
}

export const DEFAULT_SETTINGS: SqlitePluginSettings = {
    defaultRowLimit: 10,
    renderInLivePreview: true,
    renderMarkdownInCells: true,
    tableStyle: "default",
};

export const TABLE_STYLES: Record<string, string> = {
    default: "Standard Markdown (Default)",
    premium: "Premium (Modern)",
};

export class SqliteSettingTab extends PluginSettingTab {
    plugin: ObsidianSqlitePlugin;

    constructor(app: App, plugin: ObsidianSqlitePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Default row limit (Pagination)")
            .setDesc("Number of rows displayed per page. Set to 0 to show all rows on a single page.")
            .addText((text) =>
                text.setValue(String(this.plugin.settings.defaultRowLimit)).onChange((value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.defaultRowLimit = parsed;
                        void this.plugin.saveSettings();
                    }
                })
            );

        new Setting(containerEl)
            .setName("Render in Live Preview")
            .setDesc("Display databases directly while editing notes")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.renderInLivePreview).onChange((value) => {
                    this.plugin.settings.renderInLivePreview = value;
                    void this.plugin.saveSettings();
                    this.app.workspace.updateOptions();
                })
            );

        new Setting(containerEl)
            .setName("Render Markdown in cells")
            .setDesc("Enabled: **text** will be bold, links clickable. Disabled: shows raw database text.")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.renderMarkdownInCells).onChange((value) => {
                    this.plugin.settings.renderMarkdownInCells = value;
                    void this.plugin.saveSettings();
                    this.app.workspace.updateOptions();
                })
            );

        new Setting(containerEl)
            .setName("Table Design Theme")
            .setDesc("Select the visual style for rendered databases.")
            .addDropdown((drop) => {
                Object.entries(TABLE_STYLES).forEach(([key, label]: [string, string]) => drop.addOption(key, label));
                drop.setValue(this.plugin.settings.tableStyle);
                drop.onChange((value) => {
                    this.plugin.settings.tableStyle = value;
                    void this.plugin.saveSettings();
                    this.app.workspace.updateOptions();
                });
            });
    }
}
