import { ViewPlugin, EditorView, ViewUpdate } from "@codemirror/view";
import { TFile } from "obsidian";
import { SQLITE_EXTENSIONS, DOM_ATTRIBUTES, DOM_CLASSES } from "./config";
import { SqliteResultRenderer, buildDbWindowUI } from "./renderer";
import type ObsidianSqlitePlugin from "./main";
import { extractTableNameFromQuery, getWrapperThemeClass } from "./formatters";
import { preventEventPropagation } from "./utils";
import { SqliteView, VIEW_TYPE_SQLITE } from "./SqliteView";

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
                    window.requestAnimationFrame(() => {
                        this.updateEmbeds();
                    });
                }, 600);
            }

            /**
             * CodeMirror recycles the DOM as the viewport moves, so embeds we rendered
             * into can disappear. Their renderers would otherwise stay in the map
             * forever, each holding a checked-out database connection.
             */
            pruneDetachedRenderers() {
                this.activeRenderers.forEach((renderer, el) => {
                    if (this.view.dom.contains(el)) return;
                    renderer.unload();
                    this.activeRenderers.delete(el);
                });
            }

            updateEmbeds() {
                this.pruneDetachedRenderers();
                const embeds = Array.from(this.view.dom.querySelectorAll(DOM_CLASSES.EMBED_SELECTOR));

                embeds.forEach((el) => {
                    const embed = el as HTMLElement;
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
                            void renderer.updateQuery(alt);
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
                                window.setTimeout(() => {
                                    this.view.dispatch({ selection: { anchor: pos, head: pos } });
                                    this.view.focus();
                                }, 10);
                            }
                        },
                        (e) => {
                            e.stopPropagation();
                            e.preventDefault();

                            const tableName = extractTableNameFromQuery(alt);
                            const leaf = this.plugin.app.workspace.getLeaf(true);
                            void leaf.openFile(file).then(() => {
                                if (tableName && leaf.view.getViewType() === VIEW_TYPE_SQLITE) {
                                    const view = leaf.view as SqliteView;
                                    view.activeTable = tableName;
                                    view.visibleColumns = [];
                                    if (view.db) view.renderDashboard(tableName);
                                }
                            });
                        },
                        (isEdit: boolean) => {
                            if (renderer) renderer.setEditMode(isEdit);
                        },
                        (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            if (renderer) void renderer.refresh();
                        },
                        (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            if (renderer) void renderer.copyToClipboard();
                        }
                    );

                    try {
                        // Replace any renderer still registered for this element
                        const previous = this.activeRenderers.get(embed);
                        if (previous) previous.unload();

                        renderer = new SqliteResultRenderer(tableContainer, this.plugin, alt, file);
                        void renderer.load();
                        this.activeRenderers.set(embed, renderer);
                    } catch (e) {
                        tableContainer.textContent = `SQL Error: ${String(e)}`;
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
