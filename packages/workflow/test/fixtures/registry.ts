import type { PaymentActivities } from './activities.ts';
import { defineActivities } from '../../src/index.ts';

export const payments = defineActivities<PaymentActivities>()({
  prefix: 'payments.',
  methods: {
    charge: { timeout: '10s' },
    refund: { timeout: '10s' },
    slow: { timeout: '30s' },
    reject: { timeout: '10s', retries: 0 },
    flaky: { timeout: '10s', retry: { initialInterval: '50ms', maximumAttempts: 3 } },
  },
});
