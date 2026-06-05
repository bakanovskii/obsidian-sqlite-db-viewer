import { determineCellRenderMode } from "../src/formatters";

describe("determineCellRenderMode", () => {
    test("renders markdown by default when enabled", () => {
        const { displayValue, mode } = determineCellRenderMode("**Bold**", "desc", "id", false, false, true);
        expect(mode).toBe("markdown");
        expect(displayValue).toBe("**Bold**");
    });

    test("forces readonly if raw mode is enabled", () => {
        const { mode } = determineCellRenderMode("**Bold**", "desc", "id", false, true, true);
        expect(mode).toBe("readonly"); // Bypasses markdown!
    });

    test("sets cells to editable during Edit Mode", () => {
        const { mode } = determineCellRenderMode("John", "name", "id", true, false, true);
        expect(mode).toBe("editable");
    });

    test("protects primary keys from being edited", () => {
        const { mode } = determineCellRenderMode("1", "id", "id", true, false, true);
        expect(mode).toBe("readonly"); // PK is locked
    });

    test("handles null values safely", () => {
        const { displayValue } = determineCellRenderMode(null, "name", "id", false, false, false);
        expect(displayValue).toBe("NULL");
    });
});
