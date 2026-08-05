import { App, PluginSettingTab, Setting, TFolder } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
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

type SettingKey = keyof SqlitePluginSettings;

export class SqliteSettingTab extends PluginSettingTab {
    plugin: ObsidianSqlitePlugin;

    constructor(app: App, plugin: ObsidianSqlitePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * Declarative definitions (Obsidian 1.13+). Being declarative is what puts these
     * settings into Obsidian's settings search; it is also the single source of truth
     * that {@link display} renders for older versions.
     */
    getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
        return [
            {
                name: "Default row limit (pagination)",
                desc: "Number of rows displayed per page. Set to 0 to show all rows on a single page.",
                aliases: ["rows", "page size"],
                control: {
                    type: "number",
                    key: "defaultRowLimit",
                    defaultValue: DEFAULT_SETTINGS.defaultRowLimit,
                    min: 0,
                    validate: (value) => (Number.isInteger(value) && value >= 0 ? undefined : "Enter 0 or more."),
                },
            },
            {
                name: "Render Markdown in cells",
                desc: "Enabled: **text** will be bold, links clickable. Disabled: shows raw database text.",
                control: {
                    type: "toggle",
                    key: "renderMarkdownInCells",
                    defaultValue: DEFAULT_SETTINGS.renderMarkdownInCells,
                },
            },
            {
                name: "Safety backups",
                desc:
                    "Keep a rotating copy of a database (3 slots) taken before the first write of a session, " +
                    "so the state it had when you opened it can always be recovered. Copies are named " +
                    "'<name>.backup-1.db' and open like any other database.",
                aliases: ["backup", "recover", "restore"],
                control: {
                    type: "toggle",
                    key: "safetyBackups",
                    defaultValue: DEFAULT_SETTINGS.safetyBackups,
                },
            },
            {
                name: "Backup folder",
                desc:
                    "Where backups are written when safety backups are on. Leave empty to keep them next to the " +
                    "database. Inside a chosen folder the database's own folder structure is mirrored, so files " +
                    "with the same name never collide.",
                aliases: ["backup location"],
                control: {
                    type: "folder",
                    key: "backupFolder",
                    defaultValue: BACKUP_FOLDER_ALONGSIDE,
                    placeholder: "Next to the database",
                    // The vault root would mirror straight back onto the database's own folder
                    includeRoot: false,
                },
            },
            {
                name: "Table design theme",
                desc: "Select the visual style for rendered databases.",
                control: {
                    type: "dropdown",
                    key: "tableStyle",
                    defaultValue: DEFAULT_SETTINGS.tableStyle,
                    options: TABLE_STYLES,
                },
            },
        ];
    }

    getControlValue(key: string): unknown {
        return this.plugin.settings[key as SettingKey];
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        const settings = this.plugin.settings as unknown as Record<string, unknown>;
        if (!(key in settings)) return;

        settings[key] = value;
        await this.plugin.saveSettings();

        // Cell rendering and table styling are baked into editor extensions
        if (key === "renderMarkdownInCells" || key === "tableStyle") {
            this.app.workspace.updateOptions();
        }
    }

    /**
     * Fallback renderer for Obsidian below 1.13, which has no declarative settings API.
     * Obsidian 1.13+ ignores this and renders {@link getSettingDefinitions} instead, so
     * both paths stay in step by construction.
     */
    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        for (const definition of this.getSettingDefinitions()) {
            if (!("control" in definition) || !definition.control) continue;
            if (definition.visible === false) continue;
            if (typeof definition.visible === "function" && !definition.visible()) continue;

            const control = definition.control;
            const setting = new Setting(containerEl).setName(definition.name);
            if (typeof definition.desc === "string") setting.setDesc(definition.desc);

            const commit = (value: unknown) => {
                void this.setControlValue(control.key, value);
            };

            switch (control.type) {
                case "toggle":
                    setting.addToggle((toggle) =>
                        toggle.setValue(Boolean(this.getControlValue(control.key))).onChange(commit)
                    );
                    break;

                case "number":
                    setting.addText((text) =>
                        text.setValue(String(this.getControlValue(control.key))).onChange((raw) => {
                            const parsed = parseInt(raw, 10);
                            if (!isNaN(parsed) && parsed >= 0) commit(parsed);
                        })
                    );
                    break;

                case "dropdown":
                    setting.addDropdown((drop) => {
                        Object.entries(control.options).forEach(([key, label]) => {
                            drop.addOption(key, label);
                        });
                        drop.setValue(String(this.getControlValue(control.key)));
                        drop.onChange(commit);
                    });
                    break;

                case "folder":
                    setting.addDropdown((drop) => {
                        drop.addOption(BACKUP_FOLDER_ALONGSIDE, "Next to the database (default)");
                        this.app.vault
                            .getAllLoadedFiles()
                            .filter((f) => f instanceof TFolder)
                            .forEach((f) => {
                                if (f.path !== "/") drop.addOption(f.path, f.path);
                            });
                        drop.setValue(String(this.getControlValue(control.key)));
                        drop.onChange(commit);
                    });
                    break;
            }
        }
    }
}
