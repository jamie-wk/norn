import { defineActivities } from '@norn/workflow';
import type { GreetActivities as GreetActivities$ } from './activities.ts';

export const GreetActivities = defineActivities<GreetActivities$>()({
  prefix: 'greet.',
  methods: { hello: { nonRetryable: ['BlockedNameError'] }, correlation: {}, slow: { timeout: '30s', heartbeat: '5s' } },
});
