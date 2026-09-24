// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Root ESLint flat config for the kefu-saas monorepo. */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '.codex/**',
      'work/**',
      'outputs/**',
      'package-lock.json',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Undefined globals are a typechecker concern; TypeScript handles them.
      'no-undef': 'off',
      // TypeScript strict mode already reports unused locals/parameters.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
);
