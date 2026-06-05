import { ViewPlugin, EditorView, ViewUpdate } from "@codemirror/view";
import { TFile } from "obsidian";
import { SQLITE_EXTENSIONS, DOM_ATTRIBUTES, DOM_CLASSES } from "./config";
import { SqliteResultRenderer, buildDbWindowUI } from "./renderer";
import type ObsidianSqlitePlugin from "./main";
import { getWrapperThemeClass } from "./formatters";
import { preventEventPropagation } from "./utils";

export const sqliteExtension = (plugin: ObsidianSqlitePlugin) =>
    ViewPlugin.fromClass(
        class {
            plugin: ObsidianSqlitePlugin;
            debounceTimer: number | null = null;

            // Track active renderers to prevent massive memory leaks
            activeRenderers: Map<HTMLElement, SqliteResultRenderer> = new Map();

            constructor(public view: EditorView) {
                this.plugin = plugin;
                this.scheduleUpdate();
            }

            update(update: ViewUpdate) {
                if (update.docChanged || update.viewportChanged) {
                    this.scheduleUpdate();
                }
            }

            scheduleUpdate() {
                if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
                // Debounce to 600ms to prevent UI freezing while typing rapidly
                this.debounceTimer = window.setTimeout(() => {
                    requestAnimationFrame(() => this.updateEmbeds());
                }, 600);
            }

            updateEmbeds() {
                if (!this.plugin.settings.renderInLivePreview) return;

                const embeds = this.view.dom.querySelectorAll(DOM_CLASSES.EMBED_SELECTOR) as NodeListOf<HTMLElement>;

                embeds.forEach((embed) => {
                    const src = embed.getAttribute(DOM_ATTRIBUTES.SRC) || "";
                    const alt = embed.getAttribute(DOM_ATTRIBUTES.ALT) || "";

                    const hasDbExt = SQLITE_EXTENSIONS.some((ext) => src.endsWith("." + ext));
                    if (!hasDbExt || !alt.toUpperCase().includes("SELECT")) return;

                    const lastQuery = embed.getAttribute(DOM_ATTRIBUTES.QUERY);
                    if (embed.hasAttribute(DOM_ATTRIBUTES.PROCESSED)) {
                        if (lastQuery === alt) return;

                        // SOFT UPDATE: If the user just typed a new query, don't destroy the whole UI!
                        if (this.activeRenderers.has(embed)) {
                            const renderer = this.activeRenderers.get(embed)!;
                            embed.setAttribute(DOM_ATTRIBUTES.QUERY, alt);
                            renderer.updateQuery(alt);
                            return;
                        }
                    }
                    embed.setAttribute(DOM_ATTRIBUTES.PROCESSED, "true");
                    embed.setAttribute(DOM_ATTRIBUTES.QUERY, alt);

                    const activeFile = this.plugin.app.workspace.getActiveFile();
                    const file = this.plugin.app.metadataCache.getFirstLinkpathDest(src, activeFile?.path || "");
                    if (!(file instanceof TFile)) return;

                    embed.empty();
                    embed.removeClass(DOM_CLASSES.FILE_EMBED, DOM_CLASSES.MARKDOWN_EMBED, DOM_CLASSES.IS_LOADED);
                    embed.classList.add(DOM_CLASSES.SQLITE_LIVE_EMBED);

                    const windowWrapper = embed.createEl("div");
                    const wrapperCls = getWrapperThemeClass(this.plugin.settings.tableStyle);
                    if (wrapperCls) {
                        windowWrapper.classList.add(wrapperCls);
                    }

                    // This fixes the DB Explorer randomly opening
                    preventEventPropagation(windowWrapper);

                    let renderer: SqliteResultRenderer;

                    const tableContainer = buildDbWindowUI(
                        windowWrapper,
                        src,
                        (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            const pos = this.view.posAtDOM(embed);
                            if (pos !== null) {
                                setTimeout(() => {
                                    this.view.dispatch({ selection: { anchor: pos, head: pos } });
                                    this.view.focus();
                                }, 10);
                            }
                        },
                        (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            this.plugin.app.workspace.getLeaf(true).openFile(file);
                        },
                        (isEdit: boolean) => {
                            if (renderer) renderer.setEditMode(isEdit);
                        },
                        (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            if (renderer) renderer.refresh();
                        }
                    );

                    try {
                        renderer = new SqliteResultRenderer(tableContainer, this.plugin, alt, file);
                        renderer.load();
                        this.activeRenderers.set(embed, renderer);
                    } catch (e) {
                        tableContainer.textContent = `SQL Error: ${e}`;
                    }
                });
            }

            destroy() {
                // When the user closes the note, completely destroy all tracked instances
                if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
                this.activeRenderers.forEach((renderer) => renderer.unload());
                this.activeRenderers.clear();
            }
        }
    );
