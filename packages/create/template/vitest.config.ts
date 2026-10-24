import { defineConfig } from 'vitest/config';
import { standardDecorators } from '@norn-ts/testing/vite';

export default defineConfig({
  // Vite leaves standard decorators in place and Node can't run them yet, so lower them first.
  plugins: [standardDecorators()],
  test: { testTimeout: 60_000, hookTimeout: 120_000 },
});
