import { defineConfig } from 'vitest/config';
import { typescriptDecoratorTransform } from './scripts/vitest-typescript-transform';

/**
 * Vitest configuration for interface/end-to-end tests.
 *
 * These specs boot the real NestJS application in-process and drive it over
 * HTTP with `supertest`, so they exercise the full request pipeline without
 * external infrastructure. The SWC plugin enables the decorator metadata that
 * NestJS dependency injection needs (see `vitest.config.ts` for details).
 *
 * `*.integration.spec.ts` suites are collected here too so the HTTP surface and
 * the durable adapters it depends on can be run as one interface pass; an
 * integration suite skips itself when no database is reachable, so this adds no
 * requirement to a machine without PostgreSQL.
 */
export default defineConfig({
  plugins: [typescriptDecoratorTransform()],
  test: {
    environment: 'node',
    globals: false,
    include: [
      'apps/**/*.e2e-spec.ts',
      'apps/**/*.integration.spec.ts',
      'tests/**/*.e2e-spec.ts',
      'tests/**/*.integration.spec.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Each file boots its own Nest application; allow a little extra time.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
