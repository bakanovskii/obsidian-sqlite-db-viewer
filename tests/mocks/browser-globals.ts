/**
 * Plugin code runs inside a browser window and takes its timers from `window`, as
 * Obsidian requires for popout compatibility. The tests run on plain node, which has
 * no window, so the global object stands in for one.
 */
const scope = globalThis as { window?: typeof globalThis };
scope.window ??= globalThis;
