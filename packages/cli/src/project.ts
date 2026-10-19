import { existsSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readModule, type ParsedModule } from './source.js';

const builtins = new Set(builtinModules);

export const isBuiltin = (specifier: string): boolean => specifier.startsWith('node:') || builtins.has(specifier) || builtins.has(specifier.split('/')[0]!);
export const isRelative = (specifier: string): boolean => specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..' || isAbsolute(specifier);

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

const ALIASES: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs'];

/** Resolves a relative specifier to a file on disk the way TypeScript's nodenext/bundler resolution does. */
export function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const ext = /\.[cm]?jsx?$/.exec(base)?.[0];
  if (ext) {
    const stem = base.slice(0, -ext.length);
    for (const candidate of ALIASES[ext]!) if (isFile(stem + candidate)) return stem + candidate;
    return undefined;
  }
  if (/\.[cm]?tsx?$/.test(base) && isFile(base)) return base;
  for (const candidate of EXTENSIONS) if (isFile(base + candidate)) return base + candidate;
  for (const candidate of EXTENSIONS) if (isFile(join(base, `index${candidate}`))) return join(base, `index${candidate}`);
  return undefined;
}

/** Parsed modules by absolute path, read lazily. */
export class Project {
  readonly root: string;
  private readonly cache = new Map<string, ParsedModule>();

  constructor(root: string) {
    this.root = root;
  }

  rel(file: string): string {
    return relative(this.root, file).replaceAll('\\', '/');
  }

  module(file: string): ParsedModule {
    let mod = this.cache.get(file);
    if (!mod) {
      mod = readModule(file);
      this.cache.set(file, mod);
    }
    return mod;
  }

  resolve(fromFile: string, specifier: string): string | undefined {
    return isRelative(specifier) ? resolveRelative(fromFile, specifier) : undefined;
  }

  /**
   * Whether `file` exports a value (not only a type) called `name`, following re-exports.
   * Bare package re-exports are assumed to be values.
   */
  exportsValue(file: string, name: string, seen = new Set<string>()): boolean {
    if (seen.has(file)) return false;
    seen.add(file);
    const mod = this.module(file);
    const entry = mod.exports.get(name);
    if (entry) {
      if (entry.typeOnly) return false;
      if (entry.kind === 'local') return true;
      if (!isRelative(entry.source)) return true;
      const target = this.resolve(file, entry.source);
      return target ? (entry.imported === '*' ? true : this.exportsValue(target, entry.imported, seen)) : false;
    }
    for (const source of mod.starExports) {
      if (!isRelative(source)) continue;
      const target = this.resolve(file, source);
      if (target && this.exportsValue(target, name, seen)) return true;
    }
    return false;
  }

  /** Follows a (re-)export to the module and local name that declare it. */
  findExport(file: string, name: string, seen = new Set<string>()): { file: string; local: string } | undefined {
    if (seen.has(file)) return undefined;
    seen.add(file);
    const mod = this.module(file);
    const entry = mod.exports.get(name);
    if (entry) {
      if (entry.kind === 'local') return { file, local: entry.local };
      const target = this.resolve(file, entry.source);
      return target && entry.imported !== '*' ? this.findExport(target, entry.imported, seen) : undefined;
    }
    for (const source of mod.starExports) {
      const target = this.resolve(file, source);
      const found = target && this.findExport(target, name, seen);
      if (found) return found;
    }
    return undefined;
  }
}
