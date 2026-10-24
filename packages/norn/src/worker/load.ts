import { existsSync } from 'node:fs';
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NornConfigError, type SearchAttributeType } from '../core/index.js';
import { describeWorkflow, isWorkflowClass } from '../workflow/index.js';

// `.ts` when run from source (tests, tsx), `.js` once built.
const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

export type ActivityFn = (...args: unknown[]) => Promise<unknown>;

/** `{ payments: new PaymentActivities(...) }` → `{ 'payments.charge': fn, ... }`, methods bound to their instance. */
export function activityFunctions(activities: Readonly<Record<string, object>>): Record<string, ActivityFn> {
  const out: Record<string, ActivityFn> = {};
  for (const [namespace, instance] of Object.entries(activities)) {
    if (typeof instance !== 'object' || instance === null) {
      throw new NornConfigError(`activities.${namespace} must be an object, such as an instance of your activities class`);
    }
    for (let proto: object | null = instance; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        const value = (instance as Record<string, unknown>)[key];
        const name = `${namespace}.${key}`;
        if (key === 'constructor' || typeof value !== 'function' || name in out) continue;
        out[name] = (value as ActivityFn).bind(instance);
      }
    }
  }
  return out;
}

/** A `.ts` path that is gone after a build falls back to the compiled `.js` next to it. */
function compiledFallback(path: string): string {
  const js = path.replace(/\.([cm]?)ts$/, '.$1js');
  return !existsSync(path) && js !== path && existsSync(js) ? js : path;
}

function nodeModulesOf(file: string): string {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules'))) return join(dir, 'node_modules');
    if (dirname(dir) === dir) throw new NornConfigError(`No node_modules found above ${file}`);
  }
}

export interface LoadedWorkflows {
  /** The workflows module, after the compiled `.js` fallback. */
  path: string;
  /** Every task queue the exported workflows declare. */
  taskQueues: string[];
  /** The search attributes the exported workflows declare. */
  searchAttributes: Record<string, SearchAttributeType>;
}

/** Reads the `@Workflow` classes a module exports, importing it once in Node. Writes nothing. */
export async function loadWorkflows(workflows: string | URL): Promise<LoadedWorkflows> {
  const path = compiledFallback(workflows instanceof URL ? fileURLToPath(workflows) : resolve(workflows));
  const exported = Object.values(await import(pathToFileURL(path).href)).filter(isWorkflowClass);
  if (exported.length === 0) throw new NornConfigError(`${path} exports no @Workflow classes`);
  const defs = exported.map((cls) => describeWorkflow(cls));
  const taskQueues = [...new Set(defs.map((def) => def.taskQueue))];
  const searchAttributes = Object.assign({}, ...defs.map((def) => def.searchAttributes)) as Record<string, SearchAttributeType>;
  return { path, taskQueues, searchAttributes };
}

/**
 * @internal Writes the bundle entry Temporal needs for a workflows module: Temporal runs exported
 * functions by name, so each class is wrapped with `implement()` and exported under its workflow type name.
 */
export async function writeEntry(path: string): Promise<{ workflowsPath: string; nodeModules: string }> {
  // realpath: webpack resolves symlinks (macOS /tmp), and Temporal writes its own entry next to this one.
  const entryDir = join(await realpath(tmpdir()), 'norn', createHash('sha256').update(path).digest('hex').slice(0, 16));
  await mkdir(entryDir, { recursive: true });
  const workflowsPath = join(entryDir, 'workflows.cjs');
  const implementModule = fileURLToPath(new URL(`../workflow/index${ext}`, import.meta.url));
  // Write then rename: parallel processes (Vitest forks) share this file, and a reader must never see it half-written.
  const tmp = `${workflowsPath}.${process.pid}`;
  await writeFile(
    tmp,
    `const user = require(${JSON.stringify(path)});\n` +
      `const { implement, isWorkflowClass } = require(${JSON.stringify(implementModule)});\n` +
      `for (const value of Object.values(user)) if (isWorkflowClass(value)) { const fn = implement(value); exports[fn.workflowType] = fn; }\n`,
  );
  await rename(tmp, workflowsPath);
  return { workflowsPath, nodeModules: nodeModulesOf(path) };
}
