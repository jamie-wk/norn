import { describe, expect, it } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { NornConfigError } from '@norn-ts/core';
import { activityMap, mockActivities } from '../src/index.ts';
import { defineActivities } from '@norn-ts/workflow';
import type { NotifyActivities as NotifyActivities$ } from './fixtures/activities.ts';
import { NotifyActivities } from './fixtures/refs.ts';

describe('mockActivities', () => {
  it('maps methods to registered names and records calls', async () => {
    const mocks = mockActivities(NotifyActivities, { email: async (to) => `sent to ${to}` });
    const map = activityMap(mocks);
    expect(Object.keys(map)).toEqual(['notify.email']);
    expect(await new MockActivityEnvironment().run(map['notify.email']!, 'a@b.c', 'hi')).toBe('sent to a@b.c');
    expect(mocks.email.calls).toEqual([['a@b.c', 'hi']]);
  });

  it('registers a renamed activity under its registered name', () => {
    const Renamed = defineActivities<NotifyActivities$>()({ prefix: 'notify.', methods: { email: { name: 'send-email' }, audit: {} } });
    const map = activityMap(mockActivities(Renamed, { email: async () => 'x' }));
    expect(Object.keys(map)).toEqual(['notify.send-email']);
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
