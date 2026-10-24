/**
 * Webpack settings Norn layers on top of Temporal's workflow bundler.
 *
 * Temporal compiles TypeScript workflows with swc using legacy decorator semantics. Norn workflows
 * use TC39 standard decorators, so the hook switches swc to the standard (2022-03) proposal, lowers
 * to ES2022, and lets `.js` specifiers resolve to `.ts`/`.mts` sources. Compiled JavaScript (the
 * production path) passes through untouched.
 */

interface RuleUse {
  loader?: unknown;
  options?: { jsc?: { target?: string; parser?: Record<string, unknown>; transform?: Record<string, unknown> } };
}
interface Rule {
  test?: unknown;
  use?: unknown;
}
export interface WebpackLikeConfig {
  resolve?: {
    modules?: string[];
    extensionAlias?: Record<string, string[]>;
    conditionNames?: string[];
    extensions?: string[];
  };
  module?: { rules?: unknown[] };
  [key: string]: unknown;
}

export interface NornBundlerOptions {
  /**
   * Extra package.json export conditions to resolve, such as a monorepo "source" condition.
   * Defaults to the comma-separated `NORN_DEV_CONDITIONS` environment variable.
   */
  conditions?: string[];
  /** Extra `node_modules` directories to resolve packages from, after the usual lookup. */
  modules?: string[];
}

function devConditions(): string[] {
  const raw = typeof process !== 'undefined' ? process.env.NORN_DEV_CONDITIONS : undefined;
  return raw ? raw.split(',').map((c) => c.trim()).filter(Boolean) : [];
}

/** Returns a webpack config hook for `bundlerOptions.webpackConfigHook`. */
export function nornWebpackConfigHook(options: NornBundlerOptions = {}): <T extends WebpackLikeConfig>(config: T) => T {
  const conditions = options.conditions ?? devConditions();
  return (config) => {
    for (const rule of (config.module?.rules ?? []) as Rule[]) {
      const use = rule.use as RuleUse | undefined;
      if (!use || typeof use !== 'object' || !String(use.loader ?? '').includes('swc-loader')) continue;
      const jsc = (use.options ??= {}).jsc ?? (use.options.jsc = {});
      jsc.target = 'es2022';
      jsc.parser = { syntax: 'typescript', decorators: true, ...jsc.parser };
      jsc.transform = { ...jsc.transform, legacyDecorator: false, decoratorMetadata: false, decoratorVersion: '2022-03' };
      rule.test = /\.[cm]?tsx?$/;
    }
    const resolve = (config.resolve ??= {});
    resolve.extensionAlias = { ...resolve.extensionAlias, '.js': ['.ts', '.js'], '.mjs': ['.mts', '.mjs'] };
    resolve.extensions = [...new Set([...(resolve.extensions ?? []), '.ts', '.mts', '.js', '.mjs'])];
    if (conditions.length > 0) resolve.conditionNames = [...conditions, '...'];
    if (options.modules?.length) resolve.modules = [...(resolve.modules ?? ['node_modules']), ...options.modules];
    return config;
  };
}

/** Composes Norn's hook with an optional user hook. */
export function composeWebpackHooks<T extends WebpackLikeConfig>(
  ...hooks: (((config: T) => T) | undefined)[]
): (config: T) => T {
  return (config) => hooks.reduce<T>((acc, hook) => (hook ? hook(acc) : acc), config);
}
