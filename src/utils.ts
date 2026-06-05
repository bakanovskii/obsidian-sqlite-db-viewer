import { App, TFile, setIcon } from "obsidian";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";

// esbuild will fill this to insert WASM SQL module
declare const INJECTED_WASM_BASE64: string;

/* Global Cache for WASM sql.js */
let sqlPromise: Promise<SqlJsStatic> | null = null;

function base64ToUint8Array(base64: string): Uint8Array {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

async function getSql(): Promise<SqlJsStatic> {
    if (!sqlPromise) {
        const wasmArray = base64ToUint8Array(INJECTED_WASM_BASE64);
        sqlPromise = initSqlJs({ wasmBinary: wasmArray.buffer as ArrayBuffer });
    }
    return sqlPromise;
}

/**
 * Safely loads an SQLite database from the Obsidian Vault.
 * Uses cached WASM to avoid repeated reading.
 */
export async function loadDb(app: App, pluginId: string, file: TFile): Promise<Database> {
    const SQL = await getSql();
    const arrayBuffer = await app.vault.readBinary(file);
    return new SQL.Database(new Uint8Array(arrayBuffer));
}

/**
 * Securely applies an Obsidian SVG icon and normalizes its dimensions to match surrounding text.
 */
export function applyIcon(el: HTMLElement, iconName: string) {
    setIcon(el, iconName);
    const svg = el.querySelector("svg");
    if (svg) {
        svg.setCssStyles({
            width: "1em",
            height: "1em",
            display: "inline-flex",
            verticalAlign: "middle",
            position: "relative",
            top: "-0.1em",
        });
    }
}

/**
 * Factory function to generate standard, theme-compliant Obsidian action buttons.
 */
export function createActionBtn(
    parent: HTMLElement,
    icon: string,
    text: string,
    onClick: (e: MouseEvent) => void,
    isDanger: boolean = false
): HTMLButtonElement {
    const btn = parent.createEl("button", {
        cls: `sqlite-action-btn ${isDanger ? "is-danger" : ""}`,
    });

    applyIcon(btn.createSpan(), icon);
    btn.createSpan({ text: ` ${text}` });
    btn.onclick = onClick;

    return btn;
}

/**
 * Stops event propagation and prevents default for click/mousedown/dblclick.
 * Useful for shielding Obsidian's native embed handlers.
 */
export function preventEventPropagation(element: HTMLElement) {
    const handler = (e: Event) => {
        e.stopPropagation();
        if (e.type === "dblclick") e.preventDefault();
    };
    element.addEventListener("click", handler);
    element.addEventListener("mousedown", handler);
    element.addEventListener("dblclick", handler);
}
