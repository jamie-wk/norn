import { defineConfig } from 'vitest/config';
import { standardDecorators } from './packages/testing/src/vite.ts';

// Resolve @norn/* workspace packages to their TypeScript sources, so tests never need a build.
const conditions = ['@norn/source', 'module', 'node', 'development|production'];

export default defineConfig({
  plugins: [standardDecorators()],
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@norn/source'] } },
  test: {
    env: {
      // Lets @norn/worker's bundler hook resolve workspace packages to source inside workflow bundles.
      NORN_DEV_CONDITIONS: '@norn/source',
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'examples/*/*/test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.int.test.ts', 'examples/*/*/test/**/*.int.test.ts'],
          exclude: ['**/node_modules/**'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          pool: 'forks',
        },
      },
    ],
  },
});
