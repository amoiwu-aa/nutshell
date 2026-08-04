import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * Deliberately narrow: this is a large codebase that has never been linted, so
 * the rule set is limited to the mistakes that have actually caused bugs here
 * rather than everything the plugins can report. Widen it as the code is
 * cleaned up, not before — a lint run nobody can pass gets ignored.
 */
export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'native/**', 'build/**', '*.config.js']
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // Swallowing errors here has hidden real failures: credentials silently
      // stored in plaintext, deletions that never happened. A comment inside
      // the block is enough to mark an intentional one.
      'no-empty': ['error', { allowEmptyCatch: false }],

      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],

      // The codebase leans on `any` at the IPC boundary; not worth churning now.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-control-regex': 'off'
    }
  },

  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },

  {
    files: ['tests/**/*.{js,ts}', '**/*.test.ts'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', require: 'readonly', module: 'writable', __dirname: 'readonly' }
    }
  }
)
