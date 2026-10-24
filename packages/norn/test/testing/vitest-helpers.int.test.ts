import { describe, expect, it, vi } from 'vitest';
import { useTestEnv } from '../../src/testing/vitest.ts';
import { ReminderWorkflow } from './fixtures/workflow-classes.ts';

const notify = { email: vi.fn(async () => 'vi-fake'), audit: vi.fn(async () => 'ok') };
const env = useTestEnv({ workflows: new URL('./fixtures/workflows.ts', import.meta.url), activities: { notify }, mode: 'time-skipping' });

describe('useTestEnv', () => {
  it('provides an environment per file', async () => {
    const result = await env.workflow(ReminderWorkflow).execute({ userId: `u-${Date.now()}`, email: 'v@i.t' });
    expect(result).toEqual({ messageId: 'vi-fake', snoozed: 0 });
    expect(notify.email).toHaveBeenCalledExactlyOnceWith('v@i.t', 'reminder after 0 snoozes');
  });
});
