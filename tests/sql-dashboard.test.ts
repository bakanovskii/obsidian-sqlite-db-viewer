import type { Database } from "sql.js";
import { getDatabaseStats, getSidebarObjects } from "../src/formatters";

describe("Dashboard & Sidebar Logic", () => {
    test("getSidebarObjects safely handles completely empty databases", () => {
        // Mocking an empty SQL response
        const mockDb = { exec: jest.fn().mockReturnValue([]) };
        const result = getSidebarObjects(mockDb as unknown as Database);

        expect(result).toEqual([]); // Should return an empty array, not undefined/crash
    });

    test("getDatabaseStats returns correct counts from SQL engine", () => {
        const mockDb = {
            exec: jest
                .fn()
                .mockReturnValueOnce([{ values: [[5]] }]) // 5 Tables
                .mockReturnValueOnce([{ values: [[2]] }]), // 2 Views
        };
        const stats = getDatabaseStats(mockDb as unknown as Database);

        expect(stats).toEqual({ tableCount: 5, viewCount: 2 });
    });

    test("getDatabaseStats throws gracefully on corrupted database", () => {
        const mockDb = {
            exec: jest.fn().mockImplementation(() => {
                throw new Error("Corrupted DB");
            }),
        };

        // Ensures the UI layer can catch this specific error and show a Notice
        expect(() => getDatabaseStats(mockDb as unknown as Database)).toThrow("Corrupted DB");
    });
});
