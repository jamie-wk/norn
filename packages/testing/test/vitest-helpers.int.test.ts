import { describe, expect, it } from 'vitest';
import { mockActivities, useTestEnv } from '../src/vitest.ts';
import { Reminders } from './fixtures/contracts.ts';
import { NotifyActivities } from './fixtures/refs.ts';
import { registry } from './fixtures/registry.ts';

const mocks = mockActivities(NotifyActivities, { email: async () => 'vi-mock' });
const env = useTestEnv({ registry, mode: 'time-skipping', activities: mocks });

describe('useTestEnv', () => {
  it('provides an environment per file and vi.fn mocks', async () => {
    const result = await env.workflow(Reminders).execute({ userId: `u-${Date.now()}`, email: 'v@i.t' });
    expect(result).toEqual({ messageId: 'vi-mock', snoozed: 0 });
    expect(mocks.email).toHaveBeenCalledWith('v@i.t', 'reminder after 0 snoozes');
    expect(mocks.email).toHaveBeenCalledOnce();
  });
});
