import { describe, expect, it } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { NornConfigError } from '@norn/core';
import { activityMap, mockActivities } from '../src/index.ts';
import { NotifyActivities } from './fixtures/refs.ts';

describe('mockActivities', () => {
  it('maps methods to registered names and records calls', async () => {
    const mocks = mockActivities(NotifyActivities, { email: async (to) => `sent to ${to}` });
    const map = activityMap(mocks);
    expect(Object.keys(map)).toEqual(['notify.email']);
    expect(await new MockActivityEnvironment().run(map['notify.email']!, 'a@b.c', 'hi')).toBe('sent to a@b.c');
    expect(mocks.email.calls).toEqual([['a@b.c', 'hi']]);
  });

  it('merges several mock sets and plain records', () => {
    const a = mockActivities(NotifyActivities, { email: async () => 'x' });
    const b = mockActivities(NotifyActivities, { audit: async () => 'y' });
    expect(Object.keys(activityMap([a, b, { 'other.thing': async () => 1 }])).toSorted()).toEqual(['notify.audit', 'notify.email', 'other.thing']);
  });

  it('rejects methods the ref does not declare and non-functions', () => {
    expect(() => mockActivities(NotifyActivities, { nope: async () => 1 } as never)).toThrow(NornConfigError);
    expect(() => mockActivities(NotifyActivities, { email: 'x' } as never)).toThrow(NornConfigError);
  });
});
