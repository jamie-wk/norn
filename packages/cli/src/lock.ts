import { existsSync, readFileSync } from 'node:fs';
import { compare, type Analysis } from './analyze.js';
import { activityNames } from './emit.js';
import type { NornGenError } from './errors.js';

export interface LockedWorkflow {
  taskQueue: string;
  signals: string[];
  queries: string[];
  updates: string[];
}

/** `norn.lock.json`: every name in-flight executions may depend on. Commit it. */
export interface NornLock {
  version: 1;
  workflows: Record<string, LockedWorkflow>;
  activities: string[];
}

const names = (list: { name: string }[]) => [...new Set(list.map((h) => h.name))].sort();

export function buildLock(analysis: Analysis): NornLock {
  const workflows: Record<string, LockedWorkflow> = {};
  for (const wf of analysis.workflows.toSorted((a, b) => compare(a.name, b.name))) {
    workflows[wf.name] = { taskQueue: wf.taskQueue, signals: names(wf.signals), queries: names(wf.queries), updates: names(wf.updates) };
  }
  return { version: 1, workflows, activities: activityNames(analysis) };
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** Reads the lock file; `undefined` when there is none. */
export function readLock(path: string, rel: string): { lock?: NornLock; error?: NornGenError } {
  if (!existsSync(path)) return {};
  const invalid = (why: string): { error: NornGenError } => ({
    error: { code: 'lock-invalid', file: rel, message: `${rel} is not a valid lock file: ${why}`, hint: `Fix it, or restore it from version control. Delete it only if nothing is running yet.` },
  });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return invalid((error as Error).message);
  }
  const lock = raw as Partial<NornLock> | null;
  if (typeof lock !== 'object' || lock === null || lock.version !== 1) return invalid('expected { "version": 1, ... }');
  if (typeof lock.workflows !== 'object' || lock.workflows === null || !isStrings(lock.activities)) return invalid('expected "workflows" and "activities"');
  for (const [name, wf] of Object.entries(lock.workflows)) {
    if (typeof wf?.taskQueue !== 'string' || !isStrings(wf.signals) || !isStrings(wf.queries) || !isStrings(wf.updates)) {
      return invalid(`workflow ${name} needs taskQueue, signals, queries and updates`);
    }
  }
  return { lock: lock as NornLock };
}

/** Names in `previous` that `next` no longer has, as errors. */
export function compareLock(previous: NornLock, next: NornLock, rel: string): NornGenError[] {
  const errors: NornGenError[] = [];
  const hint = `If this is intentional (no executions in flight, or they were migrated), run norn gen --accept-rename to update ${rel}.`;
  const push = (message: string) => errors.push({ code: 'lock-removed', file: rel, message, hint });
  for (const [type, old] of Object.entries(previous.workflows).sort(([a], [b]) => compare(a, b))) {
    const now = next.workflows[type];
    if (!now) {
      push(`workflow type "${type}" was removed or renamed; in-flight executions of ${type} would fail on their next workflow task because no worker registers that type`);
      continue;
    }
    if (old.taskQueue !== now.taskQueue) {
      push(`task queue of ${type} changed from "${old.taskQueue}" to "${now.taskQueue}"; in-flight executions keep polling "${old.taskQueue}" and would stall`);
    }
    for (const kind of ['signals', 'queries', 'updates'] as const) {
      const singular = kind === 'queries' ? 'query' : kind.slice(0, -1);
      for (const name of old[kind]) {
        if (!now[kind].includes(name)) {
          push(`${singular} "${name}" of ${type} was removed or renamed; in-flight executions (and callers) still send "${name}", which would be rejected or dropped`);
        }
      }
    }
  }
  for (const name of previous.activities) {
    if (!next.activities.includes(name)) {
      push(`activity "${name}" was removed or renamed; in-flight workflows that schedule it would retry forever with no worker to run it`);
    }
  }
  return errors;
}
