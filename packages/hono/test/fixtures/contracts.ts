// The shape `norn gen` emits: types come from the classes through `import type` only.
import { contract } from '@norn-ts/core';
import type { HonoPaymentWorkflow } from './workflow-classes.ts';

export const HonoPayments = contract<typeof HonoPaymentWorkflow>()({
  name: 'HonoPaymentWorkflow',
  taskQueue: 'hono-tests',
  id: 'hono-payment-{paymentId}',
  signals: { paid: 'paid' },
  queries: { summary: 'summary' },
  updates: { addNote: 'addNote' },
});
