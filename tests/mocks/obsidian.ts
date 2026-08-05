/**
 * Minimal stand-in for the parts of the Obsidian API that DbManager touches,
 * so the write/reload logic can be exercised without a running vault.
 */

export class TFile {
    name: string;
    extension: string;
    stat = { mtime: 0, ctime: 0, size: 0 };

    constructor(public path: string) {
        this.name = path.split("/").pop() || path;
        this.extension = this.name.includes(".") ? this.name.split(".").pop()! : "";
    }
}

export const notices: string[] = [];

export class Notice {
    constructor(message: string) {
        notices.push(message);
    }
}

export function normalizePath(path: string): string {
    return path.replace(/\/+/g, "/");
}

export function setIcon() {
    /* no-op */
}

export class App {}
export class Component {}
export class MarkdownRenderChild {}
