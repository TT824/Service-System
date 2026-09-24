import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for unit tests only.
 *
 * Interface/end-to-end specs use the `.e2e-spec.ts` suffix and are excluded
 * here so they can be run separately through `npm run test:interface`.
 * `*.integration.spec.ts` suites are excluded for the same reason: they are
 * collected by `vitest.interface.config.ts`, they require a live PostgreSQL,
 * and `apps/**` is broad enough that the `*.spec.ts` pattern would otherwise
 * sweep them in. `npm test` still runs them — it uses `vitest.config.ts`, which
 * includes them on purpose.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: [
      'packages/**/*.spec.ts',
      'apps/**/*.spec.ts',
      // See `vitest.config.ts`: `.tsx` specs are a separate pattern.
      'apps/**/*.spec.tsx',
      'tests/**/*.spec.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.e2e-spec.ts',
      '**/*.integration.spec.ts',
    ],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
