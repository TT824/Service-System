import { defineConfig } from 'vitest/config';
import { typescriptDecoratorTransform } from './scripts/vitest-typescript-transform';

/**
 * Vitest configuration for the retrieval evaluation set.
 *
 * Separate from `vitest.interface.config.ts` **on purpose**: the gates must stay
 * fast, deterministic and runnable on a machine with nothing but PostgreSQL, and
 * an evaluation of retrieval is none of those. It needs the real model server,
 * a fully built index, and it takes minutes; making it a gate would mean either
 * a slow gate nobody trusts or a suite that skips itself exactly when its
 * subject is missing.
 *
 * So this is an **instrument**, not a gate: run it deliberately, read the
 * report, and keep the query set frozen. It is still covered by `eslint` and
 * `prettier` like every other file.
 *
 *   npm run eval:retrieval
 */
export default defineConfig({
  plugins: [typescriptDecoratorTransform()],
  test: {
    environment: 'node',
    globals: false,
    include: ['eval/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Hundreds of queries, each one an embedding call and two recall statements.
    testTimeout: 30 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
