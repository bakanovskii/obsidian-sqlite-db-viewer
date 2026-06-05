import { calculatePagination } from "../src/formatters";

describe("calculatePagination", () => {
    test("calculates standard 10-item pages correctly", () => {
        const { actualLimit, totalPages, startIndex, endIndex, validPage } = calculatePagination(10, 25, 1); // Requesting Page 2

        expect(actualLimit).toBe(10);
        expect(totalPages).toBe(3); // 10, 10, 5
        expect(validPage).toBe(1);
        expect(startIndex).toBe(10);
        expect(endIndex).toBe(20);
    });

    test("safely restricts negative page requests", () => {
        const { validPage, startIndex } = calculatePagination(10, 25, -5);

        expect(validPage).toBe(0); // Forced to page 1
        expect(startIndex).toBe(0);
    });

    test("safely restricts out-of-bound max page requests", () => {
        const { validPage, startIndex, endIndex } = calculatePagination(10, 25, 99);

        expect(validPage).toBe(2); // Forced to Page 3 (Index 2)
        expect(startIndex).toBe(20);
        expect(endIndex).toBe(25);
    });

    test("handles 'Show All' (rawLimit = 0)", () => {
        const { actualLimit, totalPages, startIndex, endIndex } = calculatePagination(0, 42, 0);

        expect(actualLimit).toBe(42);
        expect(totalPages).toBe(1);
        expect(startIndex).toBe(0);
        expect(endIndex).toBe(42);
    });

    test("handles completely empty databases safely", () => {
        const { totalPages, startIndex, endIndex, validPage } = calculatePagination(10, 0, 0);

        expect(totalPages).toBe(1);
        expect(validPage).toBe(0);
        expect(startIndex).toBe(0);
        expect(endIndex).toBe(0);
    });
});
