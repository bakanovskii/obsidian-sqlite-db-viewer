export default {
    preset: 'ts-jest',
    testEnvironment: 'node',
    moduleNameMapper: {
        // Obsidian is only available inside the app, so tests run against a stub
        '^obsidian$': '<rootDir>/tests/mocks/obsidian.ts',
    },
    testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/mocks/'],
};
