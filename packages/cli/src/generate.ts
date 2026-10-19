import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { glob } from 'tinyglobby';
import { Analyzer, type Analysis } from './analyze.js';
import { checkWorkflowCode } from './checks.js';
import { loadConfig, type ResolvedConfig } from './config.js';
import { emitActivities, emitContainer, emitContracts, emitRegistry, emitWorkflows, json, scheduleSpecs, searchAttributes, type EmitOptions } from './emit.js';
import { NornGenFailure, sortErrors, type NornGenError } from './errors.js';
import { buildLock, compareLock, readLock } from './lock.js';
import { Project } from './project.js';

export interface GenerateOptions {
  /** Where to look for `norn.config.ts` (walking up). Defaults to `process.cwd()`. */
  cwd?: string;
  /** Explicit config file, relative to `cwd`. */
  configPath?: string;
  /** Compare against the files on disk instead of writing them. */
  check?: boolean;
  /** Accept names removed from `norn.lock.json`, and update it. */
  acceptRename?: boolean;
  /** Write files to disk. Defaults to true (ignored with `check`). */
  write?: boolean;
}

export interface GenerateResult {
  /** Generated contents by path relative to the project root. Empty when there are errors. */
  files: Record<string, string>;
  /** Files that were (re)written, relative to the project root. */
  written: string[];
  /** In check mode: files that are missing or out of date. */
  stale: string[];
  errors: NornGenError[];
  /** The project root (the config file's directory), when the config loaded. */
  root?: string;
}

export interface AnalyzeResult {
  config: ResolvedConfig;
  analysis: Analysis;
}

const toPosix = (p: string) => p.replaceAll('\\', '/');

/** Source files matched by the config, as absolute paths. */
export async function sourceFiles(config: ResolvedConfig): Promise<string[]> {
  // Patterns may climb out of the root ('../src/**'); glob from a common base so excludes apply everywhere.
  const ups = Math.max(0, ...config.include.map((p) => /^(?:\.\.\/)*/.exec(toPosix(posix.normalize(toPosix(p))))![0].length / 3));
  let base = config.root;
  for (let i = 0; i < ups; i++) base = dirname(base);
  const prefix = toPosix(relative(base, config.root));
  const rebase = (p: string) => (prefix ? posix.normalize(`${prefix}/${toPosix(p)}`) : posix.normalize(toPosix(p)));
  const ignore = [
    ...config.exclude.map((p) => (p.startsWith('**/') ? p : rebase(p))),
    `${toPosix(relative(base, config.outDir))}/**`,
    ...(config.contractsOutFile ? [toPosix(relative(base, config.contractsOutFile))] : []),
  ];
  const files = await glob(config.include.map(rebase), { cwd: base, ignore, absolute: true, onlyFiles: true });
  return files.map((f) => resolve(f)).filter((f) => /\.[cm]?tsx?$/.test(f) && !/\.d\.[cm]?ts$/.test(f)).sort();
}

/** Reads and checks the project without generating anything. Throws {@link NornGenFailure} for config errors. */
export async function analyze(options: Pick<GenerateOptions, 'cwd' | 'configPath'> = {}): Promise<AnalyzeResult> {
  const config = await loadConfig(options);
  const project = new Project(config.root);
  const analyzer = new Analyzer(project);
  const rel = (p: string) => project.rel(p);

  if (config.providers) {
    if (!existsSync(config.providers)) {
      throw new NornGenFailure([
        { code: 'config', ...(config.configFile ? { file: rel(config.configFile) } : {}), message: `providers: ${rel(config.providers)} does not exist` },
      ]);
    }
    let exportsProviders = false;
    try {
      exportsProviders = project.exportsValue(config.providers, 'providers');
    } catch {
      exportsProviders = false;
    }
    if (!exportsProviders) {
      throw new NornGenFailure([
        {
          code: 'config',
          file: rel(config.providers),
          message: `The providers module needs an export named "providers"`,
          hint: 'export const providers = [provide(Db, () => createPool()), ...];',
        },
      ]);
    }
  }

  const files = await sourceFiles(config);
  const result = analyzer.analyze(files);
  checkWorkflowCode(project, analyzer, result.workflowFiles);
  const seen = new Set<string>();
  const errors = sortErrors(analyzer.errors).filter((e) => {
    const key = `${e.code}|${e.file}|${e.line}|${e.column}|${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { config, analysis: { ...result, errors } };
}

/** Renders every generated file, keyed by absolute path. */
export function render(config: ResolvedConfig, analysis: Analysis): Map<string, string> {
  const options: EmitOptions = { outDir: config.outDir, importExtension: config.importExtension, providers: config.providers };
  const out = new Map<string, string>();
  const at = (name: string) => join(config.outDir, name);
  out.set(at('workflows.ts'), emitWorkflows(analysis, options));
  out.set(at('activities.ts'), emitActivities(analysis, options));
  out.set(at('contracts.ts'), emitContracts(analysis, options, at('contracts.ts')));
  out.set(at('container.ts'), emitContainer(analysis, options));
  out.set(at('registry.ts'), emitRegistry(analysis, options));
  out.set(at('search-attributes.json'), json(searchAttributes(analysis)));
  out.set(at('schedules.json'), json(scheduleSpecs(analysis)));
  if (config.contractsOutFile) out.set(config.contractsOutFile, emitContracts(analysis, options, config.contractsOutFile));
  return out;
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

/**
 * Runs `norn gen`: analyzes the decorated classes, checks them, and writes (or, with `check`,
 * compares) the generated files and `norn.lock.json`. Never executes user code.
 */
export async function generate(options: GenerateOptions = {}): Promise<GenerateResult> {
  let analyzed: AnalyzeResult;
  try {
    analyzed = await analyze(options);
  } catch (error) {
    if (error instanceof NornGenFailure) return { files: {}, written: [], stale: [], errors: error.errors };
    throw error;
  }
  const { config, analysis } = analyzed;
  const fail = (errors: NornGenError[]): GenerateResult => ({ files: {}, written: [], stale: [], errors, root: config.root });
  if (analysis.errors.length > 0) return fail(analysis.errors);

  const rel = (p: string) => toPosix(relative(config.root, p));
  const rendered = render(config, analysis);
  const lock = buildLock(analysis);
  const previous = readLock(config.lockFile, rel(config.lockFile));
  if (previous.error) return fail([previous.error]);
  if (previous.lock && !options.acceptRename) {
    const removed = compareLock(previous.lock, lock, rel(config.lockFile));
    if (removed.length > 0) return fail(removed);
  }
  rendered.set(config.lockFile, json(lock));

  const files: Record<string, string> = {};
  for (const [path, content] of [...rendered].sort(([a], [b]) => (rel(a) < rel(b) ? -1 : 1))) files[rel(path)] = content;

  const changed = [...rendered].filter(([path, content]) => read(path) !== content).map(([path]) => path);
  if (options.check) return { files, written: [], stale: changed.map(rel).sort(), errors: [], root: config.root };
  if (options.write === false) return { files, written: [], stale: [], errors: [], root: config.root };
  for (const path of changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rendered.get(path)!);
  }
  return { files, written: changed.map(rel).sort(), stale: [], errors: [], root: config.root };
}
