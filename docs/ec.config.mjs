import { defineEcConfig } from '@astrojs/starlight/expressive-code';
import ecTwoSlash from 'expressive-code-twoslash';

export default defineEcConfig({
  plugins: [
    // Only ```ts twoslash blocks are type-checked, against the workspace packages' sources.
    ecTwoSlash({
      explicitTrigger: true,
      twoslashOptions: {
        compilerOptions: {
          target: 99,
          module: 99,
          moduleResolution: 100,
          strict: true,
          useDefineForClassFields: true,
          verbatimModuleSyntax: true,
          customConditions: ['@norn/source'],
          lib: ['lib.es2023.d.ts', 'lib.esnext.decorators.d.ts', 'lib.esnext.disposable.d.ts', 'lib.dom.d.ts'],
          types: [],
        },
      },
    }),
  ],
});
