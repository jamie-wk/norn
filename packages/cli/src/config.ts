import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NornGenFailure, type NornGenError } from './errors.js';

/** `norn.config.ts`. Paths are relative to the config file. */
export interface NornConfig {
  /** Source globs to scan for decorated classes. Defaults to `['src/**\/*.ts']`. */
  include?: string[];
  /** Globs to skip. Defaults to test files, declaration files and node_modules. */
  exclude?: string[];
  /** Where generated files go. Defaults to `'.norn'`. */
  outDir?: string;
  /** A module exporting `export const providers = [provide(...), ...]` for the container. */
  providers?: string;
  /** Extension used in generated relative imports. Defaults to `'.js'`. */
  importExtension?: '.js' | '.ts';
  /** Write the contracts to an extra file too, such as a package shared with API code. */
  contracts?: { outFile?: string };
}

/** Identity helper that type-checks `norn.config.ts`. */
export function defineConfig(config: NornConfig): NornConfig {
  return config;
}

export interface ResolvedConfig {
  /** The project root: the directory of the config file, or the working directory without one. */
  root: string;
  /** Absolute path of the config file, if one was found. */
  configFile: string | undefined;
  include: string[];
  exclude: string[];
  /** Absolute. */
  outDir: string;
  /** Absolute path of the providers module. */
  providers: string | undefined;
  importExtension: '.js' | '.ts';
  /** Absolute path of the extra contracts file. */
  contractsOutFile: string | undefined;
  /** Absolute path of `norn.lock.json`. */
  lockFile: string;
}

export const CONFIG_FILES = ['norn.config.ts', 'norn.config.mts', 'norn.config.js', 'norn.config.mjs'];
export const DEFAULT_INCLUDE = ['src/**/*.ts'];
export const DEFAULT_EXCLUDE = ['**/*.test.ts', '**/*.spec.ts', '**/*.d.ts', '**/node_modules/**'];
const KNOWN = new Set(['include', 'exclude', 'outDir', 'providers', 'importExtension', 'contracts']);

export interface LoadConfigOptions {
  cwd?: string;
  /** Explicit config path, relative to `cwd`. */
  configPath?: string;
}

/** Finds the nearest config file at or above `cwd`. */
export function findConfig(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_FILES) {
      const file = join(dir, name);
      if (existsSync(file) && statSync(file).isFile()) return file;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

/** Loads and validates the config. Throws {@link NornGenFailure} with `config` errors. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  let configFile: string | undefined;
  if (options.configPath) {
    configFile = resolve(cwd, options.configPath);
    if (!existsSync(configFile)) {
      throw new NornGenFailure([{ code: 'config', message: `Config file ${options.configPath} does not exist (looked in ${cwd})` }]);
    }
  } else {
    configFile = findConfig(cwd);
  }
  const root = configFile ? dirname(configFile) : cwd;
  const file = configFile ? relative(root, configFile).replaceAll('\\', '/') : undefined;
  const fail = (message: string, hint?: string): NornGenError => ({ code: 'config', message, ...(file ? { file } : {}), ...(hint ? { hint } : {}) });

  let raw: unknown = {};
  if (configFile) {
    try {
      // The query defeats the module cache so watch mode sees edits; keyed by mtime so unchanged configs are not re-imported.
      const mod = (await import(`${pathToFileURL(configFile).href}?t=${statSync(configFile).mtimeMs}`)) as { default?: unknown };
      if (mod.default === undefined) {
        throw new NornGenFailure([fail('The config file needs a default export', 'export default defineConfig({ ... })')]);
      }
      raw = mod.default;
    } catch (error) {
      if (error instanceof NornGenFailure) throw error;
      throw new NornGenFailure([fail(`Could not load the config file: ${(error as Error)?.message ?? String(error)}`)]);
    }
  }

  const errors: NornGenError[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new NornGenFailure([fail('The default export must be a config object', 'export default defineConfig({ ... })')]);
  }
  const config = raw as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!KNOWN.has(key)) errors.push(fail(`unknown option "${key}"`, `Known options: ${[...KNOWN].join(', ')}`));
  }
  if (config.include !== undefined && !isStringArray(config.include)) errors.push(fail('include must be an array of globs'));
  if (config.exclude !== undefined && !isStringArray(config.exclude)) errors.push(fail('exclude must be an array of globs'));
  if (config.outDir !== undefined && (typeof config.outDir !== 'string' || config.outDir === '')) {
    errors.push(fail('outDir must be a string'));
  }
  if (config.providers !== undefined && (typeof config.providers !== 'string' || config.providers === '')) {
    errors.push(fail('providers must be a module path'));
  }
  if (config.importExtension !== undefined && config.importExtension !== '.js' && config.importExtension !== '.ts') {
    errors.push(fail("importExtension must be '.js' or '.ts'"));
  }
  const contracts = config.contracts as { outFile?: unknown } | undefined;
  if (contracts !== undefined && (typeof contracts !== 'object' || contracts === null)) {
    errors.push(fail('contracts must be an object'));
  } else if (contracts?.outFile !== undefined && (typeof contracts.outFile !== 'string' || contracts.outFile === '')) {
    errors.push(fail('contracts.outFile must be a file path'));
  }
  if (errors.length > 0) throw new NornGenFailure(errors);

  const abs = (p: string) => (isAbsolute(p) ? p : resolve(root, p));
  const c = config as NornConfig;
  return {
    root,
    configFile,
    include: c.include ?? DEFAULT_INCLUDE,
    exclude: c.exclude ?? DEFAULT_EXCLUDE,
    outDir: abs(c.outDir ?? '.norn'),
    providers: c.providers ? abs(c.providers) : undefined,
    importExtension: c.importExtension ?? '.js',
    contractsOutFile: c.contracts?.outFile ? abs(c.contracts.outFile) : undefined,
    lockFile: join(root, 'norn.lock.json'),
  };
}
