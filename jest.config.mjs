export default {
    preset: 'ts-jest',
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/tests/mocks/browser-globals.ts'],
    moduleNameMapper: {
        // Obsidian is only available inside the app, so tests run against a stub
        '^obsidian$': '<rootDir>/tests/mocks/obsidian.ts',
    },
    testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/mocks/'],
};
