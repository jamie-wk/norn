import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { PayloadCodec } from '@temporalio/common';
import type { NornClient } from '@norn/client';
import { codecServer, hmacSha256Verifier, nornErrorHandler, signalAction, temporal, temporalWebhook, timingSafeEqual, type NornEnv } from '@norn/hono';
import { LoyaltyWorkflow, OrderWorkflow } from '@norn/example-orders-contracts';

export interface AppOptions {
  client: NornClient;
  /** Shared secret for provider webhooks (HMAC-SHA256 in `x-provider-signature`). */
  webhookSecret: string;
  /** Serve a codec endpoint for the Temporal UI when payloads are encrypted. */
  codec?: { codec: PayloadCodec; token: string };
}

interface LineItem {
  sku: string;
  qty: number;
}

async function json<T>(c: { req: { json(): Promise<unknown> } }, check: (body: Record<string, unknown>) => T): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Body must be JSON' });
  }
  if (typeof body !== 'object' || body === null) throw new HTTPException(400, { message: 'Body must be a JSON object' });
  return check(body as Record<string, unknown>);
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value === '') throw new HTTPException(400, { message: `${key} is required` });
  return value;
}

// The workflow validates SKUs; reject bad quantities here so they never reach a charge.
function qty(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100) throw new HTTPException(400, { message: 'qty must be a whole number from 1 to 100' });
  return value as number;
}

function items(value: unknown): LineItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HTTPException(400, { message: 'items must be an array' });
  return value.map((v) => ({ sku: String((v as LineItem)?.sku ?? ''), qty: qty((v as LineItem)?.qty) }));
}

/** The orders API. Every Temporal error becomes a JSON response with the right status. */
export function createApp(options: AppOptions) {
  const app = new Hono<NornEnv>();
  app.use(temporal({ client: options.client }));
  app.onError(nornErrorHandler());

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.post('/orders', async (c) => {
    const input = await json(c, (b) => ({
      orderId: str(b, 'orderId'),
      customerId: str(b, 'customerId'),
      email: str(b, 'email'),
      card: str(b, 'card'),
      items: items(b.items),
      ...(typeof b.cancelWindow === 'string' ? { cancelWindow: b.cancelWindow } : {}),
    }));
    const handle = await c.var.norn.workflow(OrderWorkflow).start(input, { searchAttributes: { CustomerId: input.customerId } });
    return c.json({ orderId: input.orderId, workflowId: handle.workflowId, runId: handle.runId }, 201);
  });

  app.get('/orders/:orderId', async (c) => {
    const handle = c.var.norn.workflow(OrderWorkflow).get({ orderId: c.req.param('orderId') });
    // Query first: once the view is final, describe() is sure to see the closed run.
    const order = await handle.query('view');
    return c.json({ ...order, workflowStatus: (await handle.describe()).status });
  });

  app.post('/orders/:orderId/items', async (c) => {
    const item = await json(c, (b) => ({ sku: str(b, 'sku'), qty: qty(b.qty) }));
    return c.json(await c.var.norn.workflow(OrderWorkflow).get({ orderId: c.req.param('orderId') }).update('addItem', item));
  });

  app.post('/orders/:orderId/submit', async (c) => {
    return c.json(await c.var.norn.workflow(OrderWorkflow).get({ orderId: c.req.param('orderId') }).update('submit'));
  });

  app.post('/orders/:orderId/cancel', async (c) => {
    const reason = await json(c, (b) => (typeof b.reason === 'string' ? b.reason : 'customer request'));
    await c.var.norn.workflow(OrderWorkflow).get({ orderId: c.req.param('orderId') }).signal('cancel', reason);
    return c.json({ accepted: true }, 202);
  });

  // A cart is an open order: the first item starts the workflow, later items update it.
  app.post('/carts/:cartId/items', async (c) => {
    const body = await json(c, (b) => ({
      customerId: str(b, 'customerId'),
      email: str(b, 'email'),
      card: str(b, 'card'),
      sku: str(b, 'sku'),
      qty: qty(b.qty),
    }));
    const orderId = c.req.param('cartId');
    const { result } = await c.var.norn
      .workflow(OrderWorkflow)
      .updateWithStart(
        { orderId, customerId: body.customerId, email: body.email, card: body.card, submit: false },
        { update: 'addItem', args: [{ sku: body.sku, qty: body.qty }] },
        { searchAttributes: { CustomerId: body.customerId } },
      );
    return c.json(result);
  });

  app.get('/customers/:customerId/loyalty', async (c) => {
    return c.json(await c.var.norn.workflow(LoyaltyWorkflow).get({ customerId: c.req.param('customerId') }).query('balance'));
  });

  app.post(
    '/webhooks/payments',
    temporalWebhook({
      verify: hmacSha256Verifier({ secret: options.webhookSecret, header: 'x-provider-signature', prefix: 'sha256=' }),
      map: (body) => {
        const event = body as { id?: string; type?: string; data?: { orderId?: string; chargeId?: string } };
        if (event.type !== 'charge.disputed' || !event.id || !event.data?.orderId || !event.data.chargeId) return null;
        return signalAction(OrderWorkflow, { orderId: event.data.orderId }, 'paymentEvent', {
          eventId: event.id,
          type: 'charge.disputed',
          chargeId: event.data.chargeId,
        });
      },
    }),
  );

  if (options.codec) {
    const { codec, token } = options.codec;
    const expected = new TextEncoder().encode(`Bearer ${token}`);
    app.route('/codec', codecServer({ codec, auth: (c) => timingSafeEqual(new TextEncoder().encode(c.req.header('authorization') ?? ''), expected) }));
  }

  return app;
}
