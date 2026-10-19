import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Client, ScheduleOverlapPolicy } from '@temporalio/client';
import type { ScheduleSpec } from '@norn/worker';

export type { ScheduleSpec };

/** Memo key that marks a schedule as created by `norn schedules sync`. */
export const MANAGED_MEMO = 'nornManaged';
/** Workflow-action memo key holding a hash of the declared spec, used to detect changes. */
export const HASH_MEMO = 'nornScheduleHash';

const OVERLAP: Record<NonNullable<ScheduleSpec['overlap']>, ScheduleOverlapPolicy> = {
  skip: 'SKIP',
  'buffer-one': 'BUFFER_ONE',
  'buffer-all': 'BUFFER_ALL',
  'cancel-other': 'CANCEL_OTHER',
  'terminate-other': 'TERMINATE_OTHER',
  'allow-all': 'ALLOW_ALL',
};

export function overlapPolicy(overlap: ScheduleSpec['overlap']): ScheduleOverlapPolicy {
  return OVERLAP[overlap ?? 'skip'];
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** A stable hash of everything sync applies from a spec. */
export function specHash(spec: ScheduleSpec): string {
  return createHash('sha256').update(JSON.stringify(stable(spec))).digest('hex').slice(0, 32);
}

export function readSchedules(file: string): ScheduleSpec[] {
  if (!existsSync(file)) throw new Error(`${file} does not exist. Run norn gen first.`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${file} must contain an array of schedules`);
  for (const s of raw as ScheduleSpec[]) {
    if (typeof s?.id !== 'string' || typeof s.workflowType !== 'string' || typeof s.taskQueue !== 'string' || !Array.isArray(s.cron)) {
      throw new Error(`${file}: every schedule needs id, workflowType, taskQueue and cron`);
    }
  }
  return raw as ScheduleSpec[];
}

export interface SyncOptions {
  client: Client;
  schedules: readonly ScheduleSpec[];
  /** Report what would change without changing anything. */
  dryRun?: boolean;
  /** Delete Norn-managed schedules that are no longer declared. */
  prune?: boolean;
}

export interface SyncResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  deleted: string[];
  /** Declared IDs that exist but were not created by Norn; they are left alone. */
  conflicts: string[];
}

function scheduleParts(spec: ScheduleSpec) {
  return {
    spec: { cronExpressions: [...spec.cron], ...(spec.timeZone ? { timezone: spec.timeZone } : {}) },
    action: {
      type: 'startWorkflow' as const,
      workflowType: spec.workflowType,
      taskQueue: spec.taskQueue,
      args: spec.input === undefined ? [] : [spec.input],
      memo: { [HASH_MEMO]: specHash(spec) },
    },
    policies: { overlap: overlapPolicy(spec.overlap), pauseOnFailure: spec.pauseOnFailure ?? false },
    state: { paused: spec.paused ?? false, ...(spec.note !== undefined ? { note: spec.note } : {}) },
  };
}

/**
 * Makes the namespace's schedules match the declared ones: creates missing schedules, updates
 * changed ones, and with `prune` deletes managed schedules that are no longer declared.
 * Schedules Norn did not create are never modified or deleted.
 */
export async function syncSchedules(options: SyncOptions): Promise<SyncResult> {
  const { client, schedules, dryRun = false, prune = false } = options;
  const { ScheduleNotFoundError } = await import('@temporalio/client');
  const result: SyncResult = { created: [], updated: [], unchanged: [], deleted: [], conflicts: [] };
  const ids = new Set<string>();

  for (const spec of [...schedules].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (ids.has(spec.id)) throw new Error(`Schedule id "${spec.id}" is declared more than once`);
    ids.add(spec.id);
    const handle = client.schedule.getHandle(spec.id);
    let description;
    try {
      description = await handle.describe();
    } catch (error) {
      if (!(error instanceof ScheduleNotFoundError)) throw error;
    }
    const parts = scheduleParts(spec);
    if (!description) {
      if (!dryRun) await client.schedule.create({ scheduleId: spec.id, ...parts, memo: { [MANAGED_MEMO]: true } });
      result.created.push(spec.id);
      continue;
    }
    if (description.memo?.[MANAGED_MEMO] !== true) {
      result.conflicts.push(spec.id);
      continue;
    }
    if (description.action.memo?.[HASH_MEMO] === parts.action.memo[HASH_MEMO]) {
      result.unchanged.push(spec.id);
      continue;
    }
    if (!dryRun) {
      await handle.update((previous) => ({
        ...parts,
        policies: { ...parts.policies, catchupWindow: previous.policies.catchupWindow },
      }));
    }
    result.updated.push(spec.id);
  }

  if (prune) {
    // Listing is eventually consistent; schedules created moments ago may not show up yet.
    for await (const summary of client.schedule.list()) {
      if (ids.has(summary.scheduleId) || summary.memo?.[MANAGED_MEMO] !== true) continue;
      if (!dryRun) await client.schedule.getHandle(summary.scheduleId).delete();
      result.deleted.push(summary.scheduleId);
    }
    result.deleted.sort();
  }
  return result;
}
