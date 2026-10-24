import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NornConfigError } from '@norn-ts/core';
import { describeWorkflow, isWorkflowClass } from '@norn-ts/workflow';
import type { NornRegistry } from './registry.js';

type ActivityFn = (...args: unknown[]) => Promise<unknown>;

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

function nodeModulesOf(file: string): string {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules'))) return join(dir, 'node_modules');
    if (dirname(dir) === dir) throw new NornConfigError(`No node_modules found above ${file}`);
  }
}

/**
 * A registry built from a workflows module and activity instances, with no `norn gen`. The module
 * is imported once to read the `@Workflow` classes it exports; the bundle entry wraps each class
 * with `implement()` and exports it under its workflow type name, which is how Temporal finds it.
 */
export async function plainRegistry(workflows: string | URL, activities: Readonly<Record<string, object>>): Promise<NornRegistry> {
  const path = workflows instanceof URL ? fileURLToPath(workflows) : resolve(workflows);
  const exported = Object.values(await import(pathToFileURL(path).href)).filter(isWorkflowClass);
  if (exported.length === 0) throw new NornConfigError(`${path} exports no @Workflow classes`);
  const taskQueues = [...new Set(exported.map((cls) => describeWorkflow(cls).taskQueue))];

  const workflowModule = fileURLToPath(import.meta.resolve('@norn-ts/workflow'));
  // Temporal's bundle entry is written next to this file and must resolve @temporalio/workflow, so it lives in the project's node_modules.
  const entryDir = join(nodeModulesOf(path), '.cache', 'norn', createHash('sha256').update(path).digest('hex').slice(0, 16));
  await mkdir(entryDir, { recursive: true });
  const entry = join(entryDir, 'workflows.cjs');
  await writeFile(
    entry,
    `const user = require(${JSON.stringify(path)});\n` +
      `const { implement, isWorkflowClass } = require(${JSON.stringify(workflowModule)});\n` +
      `for (const value of Object.values(user)) if (isWorkflowClass(value)) { const fn = implement(value); exports[fn.workflowType] = fn; }\n`,
  );

  const fns = activityFunctions(activities);
  return {
    workflowsPath: entry,
    taskQueues,
    activities: Object.keys(fns),
    searchAttributes: {},
    createContainer: () => ({
      resolve: () => Promise.reject(new NornConfigError('Plain activities have no dependency container')),
      activities: async () => fns,
      [Symbol.asyncDispose]: async () => {},
    }),
  };
}
