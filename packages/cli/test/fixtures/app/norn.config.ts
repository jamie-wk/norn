import { defineConfig } from '@norn/cli';

export default defineConfig({
  include: ['src/**/*.ts'],
  outDir: '.norn',
  providers: 'src/providers.ts',
  contracts: { outFile: 'shared/contracts.ts' },
});
