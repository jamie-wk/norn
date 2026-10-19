import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { createLocalEnv } from '../../../tooling/test-support/temporal.ts';
import { main } from '../src/cli.ts';
import { syncSchedules, HASH_MEMO } from '../src/schedules.ts';
import type { ScheduleSpec } from '@norn/worker';
import { project, removeDir, writeFiles } from './helpers.ts';

let env: TestWorkflowEnvironment;
let dir: string;
let output = '';

const nightly: ScheduleSpec = {
  id: 'nightly-report',
  workflowType: 'ReportWorkflow',
  taskQueue: 'reports',
  cron: ['0 2 * * *'],
  input: { kind: 'daily' },
  overlap: 'buffer-one',
  timeZone: 'America/New_York',
  note: 'Nightly totals',
};
const weekly: ScheduleSpec = { id: 'weekly-report', workflowType: 'ReportWorkflow', taskQueue: 'reports', cron: ['0 9 * * 1'], paused: true, pauseOnFailure: true };

function declare(schedules: ScheduleSpec[]) {
  writeFiles(dir, { '.norn/schedules.json': JSON.stringify(schedules) });
}

async function sync(...args: string[]) {
  output = '';
  const code = await main(['schedules', 'sync', ...args], {
    cwd: dir,
    env: { TEMPORAL_ADDRESS: env.address, TEMPORAL_NAMESPACE: env.namespace ?? 'default' },
    stdout: (s) => (output += s),
    stderr: (s) => (output += s),
  });
  return code;
}

async function listed(id: string) {
  for await (const s of env.client.schedule.list()) if (s.scheduleId === id) return s;
  return undefined;
}

beforeAll(async () => {
  env = await createLocalEnv();
  dir = project({ 'src/x.ts': 'export const x = 1;\n' });
});

afterAll(async () => {
  removeDir(dir);
  await env?.teardown();
});

describe('norn schedules sync', () => {
  it('creates declared schedules as norn-managed', async () => {
    declare([nightly, weekly]);
    expect(await sync('--dry-run')).toBe(0);
    expect(output).toContain('Dry run: 2 would be created');
    await expect(env.client.schedule.getHandle('nightly-report').describe()).rejects.toThrow();

    expect(await sync()).toBe(0);
    expect(output).toContain('created    nightly-report');
    expect(output).toContain('2 created, 0 updated, 0 unchanged, 0 deleted');

    const d = await env.client.schedule.getHandle('nightly-report').describe();
    expect(d.memo).toEqual({ nornManaged: true });
    expect(d.action).toMatchObject({ type: 'startWorkflow', workflowType: 'ReportWorkflow', taskQueue: 'reports', args: [{ kind: 'daily' }] });
    expect(d.policies).toMatchObject({ overlap: 'BUFFER_ONE', pauseOnFailure: false });
    expect(d.spec.timezone).toBe('America/New_York');
    expect(d.state).toMatchObject({ paused: false, note: 'Nightly totals' });
    const w = await env.client.schedule.getHandle('weekly-report').describe();
    expect(w.state.paused).toBe(true);
    expect(w.policies).toMatchObject({ overlap: 'SKIP', pauseOnFailure: true });
  });

  it('leaves unchanged schedules alone and updates changed ones', async () => {
    expect(await sync()).toBe(0);
    expect(output).toContain('0 created, 0 updated, 2 unchanged');

    declare([{ ...nightly, cron: ['0 3 * * *'], overlap: 'allow-all', note: 'Moved to 3am' }, weekly]);
    expect(await sync()).toBe(0);
    expect(output).toContain('updated    nightly-report');
    expect(output).toContain('0 created, 1 updated, 1 unchanged');
    const d = await env.client.schedule.getHandle('nightly-report').describe();
    expect(d.policies.overlap).toBe('ALLOW_ALL');
    expect(d.state.note).toBe('Moved to 3am');
    expect(d.spec.calendars?.[0]).toMatchObject({ hour: [{ start: 3, end: 3, step: 1 }] });
    expect(d.memo).toEqual({ nornManaged: true });
    expect(d.action.memo?.[HASH_MEMO]).toEqual(expect.any(String));
  });

  it('never touches schedules it did not create', async () => {
    await env.client.schedule.create({
      scheduleId: 'hand-made',
      spec: { cronExpressions: ['0 1 * * *'] },
      action: { type: 'startWorkflow', workflowType: 'Other', taskQueue: 'other' },
    });
    declare([nightly, weekly, { ...weekly, id: 'hand-made' }]);
    expect(await sync()).toBe(1);
    expect(output).toContain('conflict   hand-made');
    const d = await env.client.schedule.getHandle('hand-made').describe();
    expect(d.action.workflowType).toBe('Other');
  });

  it('prunes managed schedules that are no longer declared, only with --prune', async () => {
    await expect.poll(async () => (await listed('weekly-report'))?.memo, { timeout: 15_000 }).toEqual({ nornManaged: true });
    await expect.poll(async () => listed('hand-made'), { timeout: 15_000 }).toBeDefined();
    declare([nightly]);
    expect(await sync()).toBe(0);
    expect(output).toContain('0 deleted');
    expect(await sync('--prune', '--dry-run')).toBe(0);
    expect(output).toContain('deleted    weekly-report');
    await env.client.schedule.getHandle('weekly-report').describe();

    expect(await sync('--prune')).toBe(0);
    expect(output).toContain('0 updated, 1 unchanged, 1 deleted');
    await expect(env.client.schedule.getHandle('weekly-report').describe()).rejects.toThrow();
    expect((await env.client.schedule.getHandle('hand-made').describe()).action.workflowType).toBe('Other');
  });

  it('is available programmatically', async () => {
    const result = await syncSchedules({ client: env.client, schedules: [nightly], dryRun: true });
    expect(result).toEqual({ created: [], updated: [], unchanged: ['nightly-report'], deleted: [], conflicts: [] });
    await expect(syncSchedules({ client: env.client, schedules: [nightly, nightly] })).rejects.toThrow(/more than once/);
  });

  it('reports connection failures', async () => {
    output = '';
    const code = await main(['schedules', 'sync'], { cwd: dir, env: { TEMPORAL_ADDRESS: '127.0.0.1:1' }, stdout: (s) => (output += s), stderr: (s) => (output += s) });
    expect(code).toBe(1);
    expect(output).toContain('Could not connect to Temporal at 127.0.0.1:1');
  });
});
