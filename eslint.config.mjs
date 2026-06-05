import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

export default defineConfig([
    {
        ignores: ['node_modules/', 'main.js', 'build/', 'dist/', '*.wasm', '*.mjs'],
    },
    
    eslint.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    eslintConfigPrettier,
    
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.node,
                activeDocument: 'readonly',
                activeWindow: 'readonly'
            },
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            /* Strict typing */
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unsafe-argument': 'error',
            '@typescript-eslint/no-unsafe-assignment': 'error',
            '@typescript-eslint/no-unsafe-member-access': 'error',
            '@typescript-eslint/no-unsafe-call': 'error',
            '@typescript-eslint/no-unsafe-return': 'error',
            '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],

            /* Obsidian API rules */
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],

            /* Obsidian secure rules */
            'no-restricted-globals': [
                'error',
                {
                    name: 'setTimeout',
                    message: 'Use window.setTimeout() for popout window compatibility in Obsidian.',
                },
                {
                    name: 'document',
                    message: 'Use activeDocument instead of document for popout window compatibility.',
                }
            ],
            'no-restricted-properties': [
                'error',
                {
                    property: 'innerHTML',
                    message: 'Unsafe assignment to innerHTML. Use createEl or sanitizeHTMLToDom to prevent XSS.',
                },
                {
                    property: 'outerHTML',
                    message: 'Unsafe assignment to outerHTML. Use createEl or sanitizeHTMLToDom to prevent XSS.',
                }
            ],

            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'prefer-const': 'off',
        },
    }
]);