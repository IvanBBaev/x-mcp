// Flat ESLint config (ESLint 9 + typescript-eslint 8). Type-checked linting.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['build/', 'coverage/', 'node_modules/', 'bin/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // Plain JS config files (eslint.config.js, *.config.js) are not part of any tsconfig
  // project; turn off type-aware linting for them so the parser does not demand type info.
  {
    files: ['**/*.{js,cjs,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // node:test files legitimately float the promise returned by `test(...)` — the runner
  // tracks it — so the floating-promises rule does not apply here.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
);
