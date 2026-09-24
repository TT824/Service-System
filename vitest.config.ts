import { defineConfig } from 'vitest/config';
import { typescriptDecoratorTransform } from './scripts/vitest-typescript-transform';

/** Vitest configuration that runs every test across the monorepo. */
export default defineConfig({
  // NestJS relies on TypeScript decorator metadata for dependency injection.
  plugins: [typescriptDecoratorTransform()],
  test: {
    environment: 'node',
    globals: false,
    include: [
      'packages/**/*.spec.ts',
      'apps/**/*.spec.ts',
      // Component specs need the `.tsx` extension; a `.spec.tsx` file is not
      // matched by the `*.spec.ts` pattern above. They opt into jsdom with a
      // `@vitest-environment` pragma rather than a project-wide environment.
      'apps/**/*.spec.tsx',
      'apps/**/*.e2e-spec.ts',
      'tests/**/*.spec.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
    // Keep test output readable when many workspace packages are exercised.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
