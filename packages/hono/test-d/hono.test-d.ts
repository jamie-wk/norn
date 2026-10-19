import { expectTypeOf } from 'vitest';
import { Hono } from 'hono';
import type { NornClient } from '@norn/client';
import {
  codecServer,
  nornErrorHandler,
  signalAction,
  temporal,
  temporalWebhook,
  updateAction,
  type NornEnv,
  type WebhookAction,
} from '../src/index.ts';
import { Payments, Shipments } from '../test/helpers.ts';

const app = new Hono<NornEnv>();
app.use(temporal({ address: 'localhost:7233' }));
app.onError(nornErrorHandler({ status: { WORKFLOW_CLOSED: 410, MY_CODE: 418 } }));
app.get('/', (c) => {
  expectTypeOf(c.var.norn).toEqualTypeOf<NornClient>();
  expectTypeOf(c.var.correlationId).toEqualTypeOf<string>();
  return c.text('ok');
});
app.route('/codec', codecServer({ codec: { encode: async (p) => p, decode: async (p) => p }, auth: false }));
// @ts-expect-error auth is required: a function, or false to allow anyone
codecServer({ codec: { encode: async (p) => p, decode: async (p) => p } });

// Typed action helpers.
signalAction(Payments, { paymentId: 'p' }, 'paid', { amount: 1 });
signalAction(Payments, { workflowId: 'payment-p' }, 'ping');
updateAction(Payments, { paymentId: 'p' }, 'capture', 5);
// @ts-expect-error unknown signal
signalAction(Payments, { paymentId: 'p' }, 'nope');
// @ts-expect-error wrong argument type
signalAction(Payments, { paymentId: 'p' }, 'paid', { amount: 'one' });
// @ts-expect-error missing argument
signalAction(Payments, { paymentId: 'p' }, 'failed');
// @ts-expect-error capture is an update, not a signal
signalAction(Payments, { paymentId: 'p' }, 'capture', 1);
// @ts-expect-error ID field missing from the target
signalAction(Payments, { orderId: 'p' }, 'ping');

// Plain action objects, typed by contract.
const ok: WebhookAction<typeof Payments> = { workflow: Payments, target: { paymentId: 'p' }, signal: 'failed', args: ['declined'] };
const noArgs: WebhookAction<typeof Payments> = { workflow: Payments, target: { paymentId: 'p' }, signal: 'ping' };
// @ts-expect-error wrong args for the signal
const bad: WebhookAction<typeof Payments> = { workflow: Payments, target: { paymentId: 'p' }, signal: 'failed', args: [1] };
// @ts-expect-error signal and update together
const both: WebhookAction<typeof Payments> = { workflow: Payments, target: { paymentId: 'p' }, signal: 'ping', update: 'capture', args: [] };
void [ok, noArgs, bad, both];

// @ts-expect-error verify is required: a function, or false
temporalWebhook({ map: () => null });

// Actions for different contracts can be returned together.
app.post(
  '/hook',
  temporalWebhook<NornEnv>({
    verify: false,
    map: (_body, c) => {
      expectTypeOf(c.var.correlationId).toEqualTypeOf<string>();
      return [signalAction(Payments, { paymentId: 'p' }, 'ping'), signalAction(Shipments, { workflowId: 's' }, 'delivered', 'now')];
    },
    onClosed: (info) => {
      expectTypeOf(info.error.closeStatus).toEqualTypeOf<string>();
    },
  }),
);
