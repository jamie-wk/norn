import { defineConfig } from '@norn-ts/cli';

export default defineConfig({
  include: ['src/**/*.ts'],
  providers: 'src/providers.ts',
  importExtension: '.ts',
  contracts: { outFile: '../contracts/src/index.ts' },
});
