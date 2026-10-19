/**
 * A scriptable stand-in for a payment, shipping and email provider, used by the example and the
 * end-to-end tests. Records every call (with headers) and can be told to fail or slow down.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Route = 'charges' | 'refunds' | 'shipments' | 'emails';

export interface Script {
  route: Route;
  /** Respond with this status instead of succeeding. */
  status?: number;
  body?: unknown;
  /** Wait before responding. */
  delayMs?: number;
  /** How many requests the script applies to. Default 1. */
  times?: number;
}

export interface RecordedCall {
  route: Route;
  body: Record<string, unknown>;
  idempotencyKey: string | undefined;
  correlationId: string | undefined;
  status: number;
  at: string;
}

export interface Provider {
  readonly url: string;
  readonly calls: RecordedCall[];
  close(): Promise<void>;
}

const ROUTES: readonly Route[] = ['charges', 'refunds', 'shipments', 'emails'];

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startProvider(options: { port?: number; host?: string } = {}): Promise<Provider> {
  const calls: RecordedCall[] = [];
  const scripts: Script[] = [];
  const idempotent = new Map<string, { status: number; body: unknown }>();
  let counter = 0;

  const succeed = (route: Route, body: Record<string, unknown>) => {
    counter++;
    switch (route) {
      case 'charges':
        if (body.card === 'card_declined') return { status: 402, body: { reason: 'insufficient funds' } };
        return { status: 201, body: { chargeId: `ch_${counter}`, amountCents: body.amountCents } };
      case 'refunds':
        return { status: 201, body: { refundId: `re_${counter}` } };
      case 'shipments':
        return { status: 201, body: { trackingNumber: `TRK${String(counter).padStart(6, '0')}` } };
      case 'emails':
        return { status: 202, body: { messageId: `msg_${counter}` } };
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://provider');
      const path = url.pathname.replace(/^\/+/, '');
      if (req.method === 'GET' && path === '__calls') {
        const route = url.searchParams.get('route');
        return send(res, 200, route ? calls.filter((c) => c.route === route) : calls);
      }
      if (req.method === 'POST' && path === '__script') {
        const script = (await readJson(req)) as unknown as Script;
        if (!ROUTES.includes(script.route)) return send(res, 400, { error: `unknown route ${String(script.route)}` });
        scripts.push({ times: 1, ...script });
        return send(res, 201, { scripts: scripts.length });
      }
      if (req.method === 'POST' && path === '__reset') {
        calls.length = 0;
        scripts.length = 0;
        idempotent.clear();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '__webhooks/send') {
        const { url: target, secret, event } = (await readJson(req)) as { url: string; secret: string; event: unknown };
        const payload = JSON.stringify(event);
        const signature = createHmac('sha256', secret).update(payload).digest('hex');
        const delivered = await fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-provider-signature': `sha256=${signature}` },
          body: payload,
        });
        return send(res, 200, { status: delivered.status, body: await delivered.json().catch(() => null) });
      }

      const route = path as Route;
      if (req.method !== 'POST' || !ROUTES.includes(route)) return send(res, 404, { error: 'not found' });
      const body = await readJson(req);
      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? undefined;
      const correlationId = (req.headers['x-correlation-id'] as string | undefined) ?? undefined;

      const script = scripts.find((s) => s.route === route);
      if (script) {
        script.times = (script.times ?? 1) - 1;
        if (script.times <= 0) scripts.splice(scripts.indexOf(script), 1);
        if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
      }
      let result: { status: number; body: unknown };
      if (script?.status) {
        result = { status: script.status, body: script.body ?? { error: `scripted ${script.status}` } };
      } else if (idempotencyKey && idempotent.has(`${route}:${idempotencyKey}`)) {
        result = idempotent.get(`${route}:${idempotencyKey}`)!;
      } else {
        result = succeed(route, body);
        if (idempotencyKey && result.status < 300) idempotent.set(`${route}:${idempotencyKey}`, result);
      }
      calls.push({ route, body, idempotencyKey, correlationId, status: result.status, at: new Date().toISOString() });
      return send(res, result.status, result.body);
    } catch (error) {
      return send(res, 500, { error: String(error), id: randomUUID() });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
