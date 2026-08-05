import { App, PluginSettingTab, Setting, TFolder } from "obsidian";
import type ObsidianSqlitePlugin from "./main";

export const FILTER_UNIQUE_VALUES_LIMIT = 1000;
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

/** Sentinel for "keep backups next to the database file itself". */
export const BACKUP_FOLDER_ALONGSIDE = "";

export interface SqlitePluginSettings {
    defaultRowLimit: number;
    renderMarkdownInCells: boolean;
    tableStyle: string;
    safetyBackups: boolean;
    backupFolder: string;
}

export const DEFAULT_SETTINGS: SqlitePluginSettings = {
    defaultRowLimit: 10,
    renderMarkdownInCells: true,
    tableStyle: "default",
    safetyBackups: true,
    backupFolder: BACKUP_FOLDER_ALONGSIDE,
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
                        this.plugin.saveSettings().catch(console.error);
                    }
                })
            );

        new Setting(containerEl)
            .setName("Render Markdown in cells")
            .setDesc("Enabled: **text** will be bold, links clickable. Disabled: shows raw database text.")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.renderMarkdownInCells).onChange((value) => {
                    this.plugin.settings.renderMarkdownInCells = value;
                    this.plugin.saveSettings().catch(console.error);
                    this.app.workspace.updateOptions();
                })
            );

        new Setting(containerEl)
            .setName("Safety backups")
            .setDesc(
                "Keep a rotating copy of a database (3 slots) taken before the first write of a session, " +
                    "so the state it had when you opened it can always be recovered. Copies are named " +
                    "'<name>.backup-1.db' and open like any other database."
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.safetyBackups).onChange((value) => {
                    this.plugin.settings.safetyBackups = value;
                    this.plugin.saveSettings().catch(console.error);
                    this.display();
                })
            );

        if (this.plugin.settings.safetyBackups) {
            const folders = this.app.vault.getAllLoadedFiles().filter((f) => f instanceof TFolder);

            new Setting(containerEl)
                .setName("Backup folder")
                .setDesc(
                    "Where backups are written. Inside a chosen folder the database's own folder structure " +
                        "is mirrored, so files with the same name never collide."
                )
                .addDropdown((drop) => {
                    drop.addOption(BACKUP_FOLDER_ALONGSIDE, "Next to the database (default)");
                    folders.forEach((f) => {
                        // The vault root would mirror back onto the database's own folder
                        if (f.path !== "/") drop.addOption(f.path, f.path);
                    });
                    drop.setValue(this.plugin.settings.backupFolder);
                    drop.onChange((value) => {
                        this.plugin.settings.backupFolder = value;
                        this.plugin.saveSettings().catch(console.error);
                    });
                });
        }

        new Setting(containerEl)
            .setName("Table Design Theme")
            .setDesc("Select the visual style for rendered databases.")
            .addDropdown((drop) => {
                Object.entries(TABLE_STYLES).forEach(([key, label]: [string, string]) => drop.addOption(key, label));
                drop.setValue(this.plugin.settings.tableStyle);
                drop.onChange((value) => {
                    this.plugin.settings.tableStyle = value;
                    this.plugin.saveSettings().catch(console.error);
                    this.app.workspace.updateOptions();
                });
            });
    }
}
