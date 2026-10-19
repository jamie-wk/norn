import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';
import { standardDecorators } from './packages/testing/src/vite.ts';

// Optional machine-specific settings (gitignored), such as paths to pre-downloaded Temporal binaries.
const localEnv = existsSync('.env.test.local') ? parseEnv(readFileSync('.env.test.local', 'utf8')) : {};

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
      ...localEnv,
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
      {
        // The orders example as real processes. Needs `pnpm e2e:build` first.
        extends: true,
        test: {
          name: 'e2e',
          include: ['e2e/test/**/*.e2e.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          pool: 'forks',
          fileParallelism: false,
        },
      },
    ],
  },
});
