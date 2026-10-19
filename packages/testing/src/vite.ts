/**
 * A Vite / Vitest plugin that compiles TC39 standard decorators.
 *
 * Vite 8 transforms TypeScript with Oxc, which keeps standard decorators as-is, and Node cannot
 * run them yet. This plugin lowers decorators with esbuild before Vite's own transform runs, so
 * Norn workflow, activity and service classes work in Vitest without a separate build step.
 *
 * ```ts
 * // vitest.config.ts
 * import { defineConfig } from 'vitest/config';
 * import { standardDecorators } from '@norn/testing/vite';
 *
 * export default defineConfig({ plugins: [standardDecorators()] });
 * ```
 */

export interface StandardDecoratorsOptions {
  /** Files to transform. Defaults to TypeScript files outside node_modules. */
  include?: RegExp;
  /** Files to skip even when they match `include`. */
  exclude?: RegExp;
  /** esbuild target used for lowering. Defaults to `es2022`. */
  target?: string;
}

/** The subset of the Vite plugin interface this plugin implements. */
export interface DecoratorPlugin {
  name: string;
  enforce: 'pre';
  transform(code: string, id: string): Promise<{ code: string; map: string } | null>;
}

const DEFAULT_INCLUDE = /\.[cm]?tsx?$/;
const DEFAULT_EXCLUDE = /[\\/]node_modules[\\/]/;
const DECORATOR = /(^|[\s(;{}])@[A-Za-z_$]/m;

export function standardDecorators(options: StandardDecoratorsOptions = {}): DecoratorPlugin {
  const include = options.include ?? DEFAULT_INCLUDE;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;
  const target = options.target ?? 'es2022';
  let esbuild: typeof import('esbuild') | undefined;

  return {
    name: 'norn:standard-decorators',
    enforce: 'pre',
    async transform(code, id) {
      const file = id.split('?')[0] ?? id;
      if (!include.test(file) || exclude.test(file) || !DECORATOR.test(code)) return null;
      esbuild ??= await import('esbuild');
      const result = await esbuild.transform(code, {
        loader: file.endsWith('x') ? 'tsx' : 'ts',
        target,
        format: 'esm',
        sourcemap: 'external',
        sourcefile: file,
      });
      return { code: result.code, map: result.map };
    },
  };
}
