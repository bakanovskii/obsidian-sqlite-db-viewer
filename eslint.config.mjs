import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

export default defineConfig([
    {
        ignores: ['node_modules/', 'main.js', 'build/', 'dist/', '*.wasm'],
    },
    
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    eslintConfigPrettier,
    
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            'no-undef': 'off',
            'prefer-const': 'warn',
        },
    }
]);
