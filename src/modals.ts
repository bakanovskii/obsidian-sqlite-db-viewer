import { Modal, Setting, App, Notice, TFile, TFolder } from "obsidian";
import { SQLITE_EXTENSIONS } from "./config";
import type ObsidianSqlitePlugin from "./main";
import { applyIcon, loadDb, createActionBtn } from "./utils";
import { buildCreateTableSql, generateImportSql, stripMarkdown } from "./formatters";

const SQLITE_DATA_TYPES = ["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC", "DATETIME (Auto)"] as const;

export class ConfirmModal extends Modal {
    constructor(
        app: App,
        private title: string,
        private message: string,
        private onConfirm: () => void
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: this.title });
        contentEl.createEl("p", { text: this.message });

        const foot = contentEl.createEl("div", { cls: "sqlite-modal-footer" });
        foot.setCssStyles({ gap: "8px" });

        createActionBtn(foot, "x", "Cancel", () => this.close());
        createActionBtn(
            foot,
            "check",
            "Confirm",
            () => {
                this.onConfirm();
                this.close();
            },
            true
        );
    }

    onClose() {
        this.contentEl.empty();
    }
}

export class RenameTableModal extends Modal {
    newName: string;

    constructor(
        app: App,
        private oldName: string,
        private onRename: (newName: string) => void
    ) {
        super(app);
        this.newName = oldName;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Rename table" });

        new Setting(contentEl)
            .setName("New name")
            .addText((t) => t.setValue(this.newName).onChange((v) => (this.newName = v.trim())));

        const foot = contentEl.createEl("div", { cls: "sqlite-modal-footer" });
        createActionBtn(foot, "check", "Save", () => {
            if (this.newName && this.newName !== this.oldName) {
                this.onRename(this.newName);
            }
            this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

export class CreateTableModal extends Modal {
    tableName: string = "new_table";
    columns: { name: string; type: string; isPk: boolean }[] = [];

    constructor(
        app: App,
        private executeSql: (sql: string) => void
    ) {
        super(app);
        this.columns.push({ name: "id", type: "INTEGER", isPk: true });
    }

    onOpen() {
        this.modalEl.classList.add("sqlite-modal");
        this.renderUI();
    }

    renderUI() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Table Constructor" });

        new Setting(contentEl).setName("Table name").addText((t) => {
            t.setValue(this.tableName).onChange((v) => (this.tableName = v));
            t.inputEl.classList.add("sqlite-accent-input");
        });

        const titleEl = contentEl.createEl("div", { text: "COLUMNS", cls: "sqlite-schema-title" });
        titleEl.setCssStyles({ marginTop: "25px" });

        const colContainer = contentEl.createEl("div", { cls: "sqlite-col-container" });
        colContainer.setCssStyles({
            marginTop: "10px",
            paddingTop: "10px",
            borderTop: "1px solid var(--background-modifier-border)",
        });

        this.columns.forEach((col, index) => {
            const row = colContainer.createEl("div", { cls: "sqlite-col-row" });

            const nameInput = row.createEl("input", { type: "text", cls: "sqlite-accent-input" });
            nameInput.placeholder = "Column Name";
            nameInput.value = col.name;
            nameInput.setCssStyles({ flex: "1" });
            nameInput.oninput = (e) => (col.name = (e.target as HTMLInputElement).value);

            const typeSelect = row.createEl("select", { cls: "dropdown sqlite-accent-input" });
            SQLITE_DATA_TYPES.forEach((type) => {
                const opt = typeSelect.createEl("option", { text: type, value: type });
                if (type === col.type) opt.selected = true;
            });
            typeSelect.onchange = (e) => (col.type = (e.target as HTMLSelectElement).value);

            const pkLabel = row.createEl("label");
            pkLabel.setCssStyles({
                display: "flex",
                alignItems: "center",
                gap: "4px",
                cursor: "pointer",
                fontSize: "12px",
            });

            const pkCheckbox = pkLabel.createEl("input", { type: "checkbox" });
            pkCheckbox.checked = col.isPk;
            pkLabel.createSpan({ text: "PK" });
            pkLabel.title = "Primary Key";

            pkCheckbox.onchange = (e) => {
                const isChecked = (e.target as HTMLInputElement).checked;
                if (isChecked) this.columns.forEach((c) => (c.isPk = false));
                col.isPk = isChecked;
                this.renderUI();
            };

            const delBtn = createActionBtn(
                row,
                "trash",
                "",
                () => {
                    this.columns.splice(index, 1);
                    this.renderUI();
                },
                true
            );
            delBtn.setCssStyles({ padding: "5px 8px" });
        });

        const addBtnContainer = contentEl.createEl("div");
        addBtnContainer.setCssStyles({ marginTop: "15px" });
        const addBtn = addBtnContainer.createEl("button", { cls: "sqlite-dashed-btn" });
        applyIcon(addBtn, "plus");
        addBtn.onclick = () => {
            this.columns.push({ name: `col_${this.columns.length + 1}`, type: "TEXT", isPk: false });
            this.renderUI();
        };

        const foot = contentEl.createEl("div", { cls: "sqlite-modal-footer" });

        createActionBtn(foot, "check", "Create Table", () => {
            const sql = buildCreateTableSql(this.tableName, this.columns);
            this.executeSql(sql);
            this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

export class CreateDatabaseModal extends Modal {
    fileName: string = "NewDatabase";
    folderPath: string = "/";

    constructor(
        app: App,
        private plugin: ObsidianSqlitePlugin
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Create new SQLite DB" });

        new Setting(contentEl)
            .setName("File name")
            .setDesc("By default uses .db extension")
            .addText((text) => text.setValue(this.fileName).onChange((val) => (this.fileName = val)));

        const folders = this.app.vault.getAllLoadedFiles().filter((f) => f instanceof TFolder);

        new Setting(contentEl)
            .setName("Folder")
            .setDesc("Select destination directory")
            .addDropdown((drop) => {
                drop.addOption("/", "Vault Root (/)");
                folders.forEach((f) => {
                    if (f.path !== "/") drop.addOption(f.path, f.path);
                });
                drop.setValue("/");
                drop.onChange((val) => (this.folderPath = val));
            });

        const foot = contentEl.createEl("div", { cls: "sqlite-modal-footer" });
        createActionBtn(foot, "check", "Create", () => {
            this.close();
            void this.plugin.createNewDatabase(this.fileName, this.folderPath);
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

export class ImportTableModal extends Modal {
    selectedFile: string = "";
    tableName: string = "new_table";
    keepMarkdown: boolean = true;
    addPrimaryKey: boolean = false;

    constructor(
        app: App,
        private plugin: ObsidianSqlitePlugin,
        private headers: string[],
        private rows: string[][]
    ) {
        super(app);
    }

    onOpen() {
        this.modalEl.classList.add("sqlite-modal");
        const { contentEl } = this;
        contentEl.createEl("h2", { text: `Import table (${this.rows.length} rows)` });

        const dbFiles = this.app.vault.getFiles().filter((f) => SQLITE_EXTENSIONS.includes(f.extension));

        if (dbFiles.length === 0) {
            contentEl.createEl("p", { text: "No available databases. Create a DB first." });
            return;
        }
        this.selectedFile = dbFiles[0].path;

        new Setting(contentEl).setName("Database").addDropdown((drop) => {
            dbFiles.forEach((f) => drop.addOption(f.path, f.name));
            drop.setValue(this.selectedFile);
            drop.onChange((val) => (this.selectedFile = val));
            drop.selectEl.classList.add("sqlite-accent-input");
        });

        new Setting(contentEl).setName("New table name").addText((text) => {
            text.setValue(this.tableName).onChange((val) => (this.tableName = val));
            text.inputEl.classList.add("sqlite-accent-input");
        });

        new Setting(contentEl)
            .setName("Keep Markdown")
            .setDesc("Keep links, bold text, and highlights. If disabled, only plain text is saved to the DB.")
            .addToggle((toggle) => toggle.setValue(this.keepMarkdown).onChange((val) => (this.keepMarkdown = val)));

        new Setting(contentEl)
            .setName("Add Primary Key")
            .setDesc(
                "Automatically generate an 'id' column with auto-incrementing numbers (Required for Live Editing)."
            )
            .addToggle((toggle) => toggle.setValue(this.addPrimaryKey).onChange((val) => (this.addPrimaryKey = val)));

        const foot = contentEl.createEl("div", { cls: "sqlite-modal-footer" });

        createActionBtn(foot, "database", "Import", () => {
            this.close();
            this.doImport().catch(console.error);
        });
    }

    async doImport() {
        try {
            if (this.headers.length === 0) {
                new Notice("Error: Table is empty or has no headers!");
                return;
            }

            const finalHeaders = this.keepMarkdown ? this.headers : this.headers.map((h) => stripMarkdown(h));
            const finalRows = this.keepMarkdown
                ? this.rows
                : this.rows.map((row) => row.map((cell) => stripMarkdown(cell)));

            const file = this.app.vault.getAbstractFileByPath(this.selectedFile);
            if (!(file instanceof TFile)) return;

            const db = await loadDb(this.app, this.plugin.manifest.id, file);

            const { createTableSql, insertSql } = generateImportSql(this.tableName, finalHeaders, this.addPrimaryKey);

            db.exec(createTableSql);
            const stmt = db.prepare(insertSql);

            db.exec("BEGIN TRANSACTION;");
            finalRows.forEach((row) => stmt.run(row));
            db.exec("COMMIT;");

            stmt.free();

            const buffer = db.export().buffer;
            await this.app.vault.modifyBinary(file, buffer as ArrayBuffer);
            new Notice(`Table ${this.tableName} imported successfully!`);
        } catch (e) {
            new Notice(`Import error: ${String(e)}`);
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
