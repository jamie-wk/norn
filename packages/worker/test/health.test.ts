import { afterEach, describe, expect, it } from 'vitest';
import { startHealthServer, type HealthServer } from '../src/index.ts';

let server: HealthServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('health server', () => {
  it('serves liveness, readiness and 404s', async () => {
    let ready = false;
    server = await startHealthServer({ port: 0, ready: () => ready });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const notReady = await fetch(`${base}/readyz`);
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({ status: 'not ready' });
    ready = true;
    const isReady = await fetch(`${base}/readyz`);
    expect(isReady.status).toBe(200);
    expect(await isReady.json()).toEqual({ status: 'ready' });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(405);
  });

  it('includes details from the readiness callback', async () => {
    server = await startHealthServer({ port: 0, ready: () => ({ ready: false, details: { 'w-main': 'DRAINING' } }) });
    const res = await fetch(`http://127.0.0.1:${server.port}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'not ready', details: { 'w-main': 'DRAINING' } });
  });

  it('fails clearly when the port is taken', async () => {
    server = await startHealthServer({ port: 0, ready: () => true });
    await expect(startHealthServer({ port: server.port, ready: () => true })).rejects.toThrow(/port/);
  });
});
