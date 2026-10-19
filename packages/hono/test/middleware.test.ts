import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import { getCorrelationId } from '@norn/client';
import { NornConfigError } from '@norn/core';
import { temporal, type NornEnv } from '../src/index.ts';
import { fakeClient } from './helpers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function app(options: Parameters<typeof temporal>[0] = { client: fakeClient() }) {
  const a = new Hono<NornEnv>();
  a.use(temporal(options));
  a.get('/id', async (c) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return c.json({ als: getCorrelationId(), var: c.var.correlationId });
  });
  return a;
}

describe('temporal() middleware: client', () => {
  it('puts the given client on c.var.norn', async () => {
    const client = fakeClient();
    const a = new Hono<NornEnv>();
    a.use(temporal({ client }));
    a.get('/', (c) => c.json({ same: c.var.norn === client, viaGet: c.get('norn') === client }));
    expect(await (await a.request('/')).json()).toEqual({ same: true, viaGet: true });
  });

  it('creates one client lazily from ClientOptions and reuses it', async () => {
    const mw = temporal({ address: '127.0.0.1:1', namespace: 'lazy-ns' });
    const seen: unknown[] = [];
    const a = new Hono<NornEnv>();
    a.use(mw);
    a.get('/', (c) => {
      seen.push(c.var.norn);
      return c.text('ok');
    });
    await a.request('/');
    await a.request('/');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(mw.client).toBe(seen[0]);
    expect((seen[0] as { temporal: { options: { namespace: string } } }).temporal.options.namespace).toBe('lazy-ns');
    await mw.close();
    await mw.close();
  });

  it('does not create a client before the first request, and close() is then a no-op', async () => {
    const mw = temporal({ address: '127.0.0.1:1' });
    await expect(mw.close()).resolves.toBeUndefined();
  });

  it('never closes a client it did not create', async () => {
    const client = fakeClient();
    let closed = false;
    client.close = async () => {
      closed = true;
    };
    const mw = temporal({ client });
    expect(mw.client).toBe(client);
    await mw.close();
    expect(closed).toBe(false);
  });

  it('rejects invalid options at creation', () => {
    expect(() => temporal({ client: {} as never })).toThrow(NornConfigError);
    expect(() => temporal({ correlationHeader: '' })).toThrow(NornConfigError);
    expect(() => temporal({ correlationHeader: 'bad header' })).toThrow(NornConfigError);
    expect(() => temporal({ requestIdHeader: 'x y' })).toThrow(NornConfigError);
    expect(() => temporal(undefined as never)).toThrow(NornConfigError);
  });
});

describe('temporal() middleware: correlation IDs', () => {
  it('uses x-correlation-id inside the request (across awaits) and echoes it', async () => {
    const res = await app().request('/id', { headers: { 'x-correlation-id': 'corr-123' } });
    expect(res.headers.get('x-correlation-id')).toBe('corr-123');
    expect(await res.json()).toEqual({ als: 'corr-123', var: 'corr-123' });
  });

  it('falls back to x-request-id', async () => {
    const res = await app().request('/id', { headers: { 'x-request-id': 'req.7:a_b-c' } });
    expect(res.headers.get('x-correlation-id')).toBe('req.7:a_b-c');
    expect(await res.json()).toEqual({ als: 'req.7:a_b-c', var: 'req.7:a_b-c' });
  });

  it('prefers x-correlation-id over x-request-id', async () => {
    const res = await app().request('/id', { headers: { 'x-correlation-id': 'corr', 'x-request-id': 'req' } });
    expect(res.headers.get('x-correlation-id')).toBe('corr');
  });

  it('generates a UUID when no header is present, different per request', async () => {
    const a = app();
    const one = await a.request('/id');
    const two = await a.request('/id');
    const id = one.headers.get('x-correlation-id')!;
    expect(id).toMatch(UUID);
    expect(await one.json()).toEqual({ als: id, var: id });
    expect(two.headers.get('x-correlation-id')).not.toBe(id);
  });

  it.each([
    ['too long', 'a'.repeat(129)],
    ['spaces', 'has space'],
    ['injection', 'abcé'],
    ['slashes', 'a/b'],
    ['quotes', '"x"'],
    ['empty', ''],
  ])('replaces an invalid incoming ID (%s)', async (_label, value) => {
    const headers = new Headers();
    try {
      headers.set('x-correlation-id', value);
    } catch {
      // Not representable as a header at all.
    }
    const res = await app().request('/id', { headers });
    expect(res.headers.get('x-correlation-id')).toMatch(UUID);
  });

  it('accepts an ID of exactly 128 allowed characters', async () => {
    const id = 'A9._:-'.repeat(21) + 'xy';
    expect(id).toHaveLength(128);
    const res = await app().request('/id', { headers: { 'x-correlation-id': id } });
    expect(res.headers.get('x-correlation-id')).toBe(id);
  });

  it('uses the next valid candidate when the first is invalid', async () => {
    const res = await app().request('/id', { headers: { 'x-correlation-id': 'bad id', 'x-request-id': 'good' } });
    expect(res.headers.get('x-correlation-id')).toBe('good');
  });

  it('supports a custom correlation header and disabling the request-id fallback', async () => {
    const a = app({ client: fakeClient(), correlationHeader: 'X-Trace-Id', requestIdHeader: false });
    const traced = await a.request('/id', { headers: { 'x-trace-id': 'trace-1' } });
    expect(traced.headers.get('x-trace-id')).toBe('trace-1');
    expect(traced.headers.get('x-correlation-id')).toBeNull();
    expect(await traced.json()).toMatchObject({ als: 'trace-1' });
    const fallback = await a.request('/id', { headers: { 'x-request-id': 'req-1' } });
    expect(fallback.headers.get('x-trace-id')).toMatch(UUID);
  });

  it('supports a custom request-id header', async () => {
    const a = app({ client: fakeClient(), requestIdHeader: 'cf-ray' });
    const res = await a.request('/id', { headers: { 'cf-ray': '8a1b2c3d4e-AMS' } });
    expect(res.headers.get('x-correlation-id')).toBe('8a1b2c3d4e-AMS');
  });

  it('ignores incoming IDs with trustIncoming: false', async () => {
    const a = app({ client: fakeClient(), trustIncoming: false });
    const res = await a.request('/id', { headers: { 'x-correlation-id': 'spoofed' } });
    expect(res.headers.get('x-correlation-id')).toMatch(UUID);
  });

  it("uses hono's requestId() variable when no header is sent", async () => {
    const a = new Hono<NornEnv & { Variables: { requestId: string } }>();
    a.use(requestId({ generator: () => 'from-request-id-mw' }));
    a.use(temporal({ client: fakeClient() }));
    a.get('/', (c) => c.text(getCorrelationId() ?? 'none'));
    const res = await a.request('/');
    expect(await res.text()).toBe('from-request-id-mw');
    expect(res.headers.get('x-correlation-id')).toBe('from-request-id-mw');
  });

  it('echoes the ID on raw Response objects, error responses and 404s', async () => {
    const a = new Hono<NornEnv>();
    a.use(temporal({ client: fakeClient() }));
    a.get('/raw', () => new Response('raw', { headers: { 'x-other': '1' } }));
    a.get('/frozen', () => Response.redirect('https://example.com/', 302));
    a.get('/boom', () => {
      throw new Error('boom');
    });
    a.onError((_err, c) => c.text(`error:${getCorrelationId()}`, 500));
    const headers = { 'x-correlation-id': 'echo-1' };

    const raw = await a.request('/raw', { headers });
    expect(raw.headers.get('x-correlation-id')).toBe('echo-1');
    expect(raw.headers.get('x-other')).toBe('1');
    expect(await raw.text()).toBe('raw');

    const frozen = await a.request('/frozen', { headers });
    expect(frozen.status).toBe(302);
    expect(frozen.headers.get('x-correlation-id')).toBe('echo-1');

    const boom = await a.request('/boom', { headers });
    expect(boom.status).toBe(500);
    expect(await boom.text()).toBe('error:echo-1');
    expect(boom.headers.get('x-correlation-id')).toBe('echo-1');

    const missing = await a.request('/nope', { headers });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-correlation-id')).toBe('echo-1');
  });

  it('does not overwrite a correlation header the handler set itself', async () => {
    const a = new Hono<NornEnv>();
    a.use(temporal({ client: fakeClient() }));
    a.get('/', (c) => c.text('x', 200, { 'x-correlation-id': 'handler-set' }));
    const res = await a.request('/', { headers: { 'x-correlation-id': 'incoming' } });
    expect(res.headers.get('x-correlation-id')).toBe('handler-set');
  });

  it('isolates concurrent requests', async () => {
    const a = app();
    const ids = Array.from({ length: 20 }, (_, i) => `concurrent-${i}`);
    const results = await Promise.all(ids.map(async (id) => (await a.request('/id', { headers: { 'x-correlation-id': id } })).json()));
    expect(results.map((r) => (r as { als: string }).als)).toEqual(ids);
  });

  it('has no correlation ID outside the request', async () => {
    await app().request('/id', { headers: { 'x-correlation-id': 'scoped' } });
    expect(getCorrelationId()).toBeUndefined();
  });
});
