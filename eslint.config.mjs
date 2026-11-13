import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // The n8n snippet runs inside n8n's Code node, with n8n's own globals.
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'data/**', 'examples/n8n-*.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    files: ['examples/**/*.{mjs,cjs}', 'scripts/**/*.{mjs,cjs}'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly', Buffer: 'readonly' },
    },
  },
);
