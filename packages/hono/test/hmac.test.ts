import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { NornConfigError } from '@norn-ts/core';
import { hmacSha256, hmacSha256Verifier, temporal, temporalWebhook, timingSafeEqual, type NornEnv } from '../src/index.ts';
import { fakeClient } from './helpers.ts';

const secret = 'whsec_test_secret';
const body = JSON.stringify({ type: 'payment.succeeded', id: 'p1', note: 'ünïcødé ✓' });
const sign = (data: string | Buffer, encoding: 'hex' | 'base64', key: string | Buffer = secret) => createHmac('sha256', key).update(data).digest(encoding);

function app(verify: ReturnType<typeof hmacSha256Verifier>) {
  const a = new Hono<NornEnv>();
  a.use(temporal({ client: fakeClient() }));
  a.post('/hook', temporalWebhook({ verify, map: () => null }));
  return a;
}
const post = (a: Hono<NornEnv>, headers: Record<string, string>, payload: RequestInit['body'] = body) => a.request('/hook', { method: 'POST', headers, body: payload });

describe('hmacSha256Verifier', () => {
  it('accepts a valid hex signature (default encoding)', async () => {
    const a = app(hmacSha256Verifier({ secret, header: 'x-signature' }));
    expect((await post(a, { 'x-signature': sign(body, 'hex') })).status).toBe(202);
    expect((await post(a, { 'x-signature': sign(body, 'hex').toUpperCase() })).status).toBe(202);
  });

  it('accepts a valid base64 signature', async () => {
    const a = app(hmacSha256Verifier({ secret, header: 'X-Shopify-Hmac-Sha256', encoding: 'base64' }));
    expect((await post(a, { 'x-shopify-hmac-sha256': sign(body, 'base64') })).status).toBe(202);
  });

  it('accepts unpadded and URL-safe base64', async () => {
    const a = app(hmacSha256Verifier({ secret, header: 'x-sig', encoding: 'base64' }));
    const urlSafe = sign(body, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect((await post(a, { 'x-sig': urlSafe })).status).toBe(202);
  });

  it('checks the prefix (GitHub style)', async () => {
    const a = app(hmacSha256Verifier({ secret, header: 'x-hub-signature-256', prefix: 'sha256=' }));
    expect((await post(a, { 'x-hub-signature-256': `sha256=${sign(body, 'hex')}` })).status).toBe(202);
    expect((await post(a, { 'x-hub-signature-256': sign(body, 'hex') })).status).toBe(401);
    expect((await post(a, { 'x-hub-signature-256': `sha1=${sign(body, 'hex')}` })).status).toBe(401);
  });

  it('accepts a Uint8Array secret', async () => {
    const key = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const a = app(hmacSha256Verifier({ secret: key, header: 'x-sig' }));
    expect((await post(a, { 'x-sig': sign(body, 'hex', Buffer.from(key)) })).status).toBe(202);
  });

  it('verifies the exact raw bytes, including a BOM and non-UTF-8 bytes', async () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}'), Buffer.from([0xff])]);
    const a = new Hono<NornEnv>();
    a.use(temporal({ client: fakeClient() }));
    a.post('/hook', temporalWebhook({ verify: hmacSha256Verifier({ secret, header: 'x-sig' }), parse: () => ({}), map: () => null }));
    expect((await post(a, { 'x-sig': sign(raw, 'hex') }, raw)).status).toBe(202);
  });

  it.each([
    ['wrong signature', { 'x-sig': sign('other body', 'hex') }],
    ['wrong secret', { 'x-sig': sign(body, 'hex', 'other secret') }],
    ['missing header', {}],
    ['empty header', { 'x-sig': '' }],
    ['not hex', { 'x-sig': 'zz'.repeat(32) }],
    ['odd-length hex', { 'x-sig': sign(body, 'hex').slice(1) }],
    ['truncated', { 'x-sig': sign(body, 'hex').slice(0, 32) }],
    ['too long', { 'x-sig': `${sign(body, 'hex')}00` }],
  ])('rejects %s with 401', async (_label, headers) => {
    const a = app(hmacSha256Verifier({ secret, header: 'x-sig' }));
    expect((await post(a, headers)).status).toBe(401);
  });

  it('rejects malformed base64 with 401', async () => {
    const a = app(hmacSha256Verifier({ secret, header: 'x-sig', encoding: 'base64' }));
    expect((await post(a, { 'x-sig': '!!!not-base64!!!' })).status).toBe(401);
    expect((await post(a, { 'x-sig': sign(body, 'hex') })).status).toBe(401);
  });

  it('rejects a tampered body', async () => {
    const a = app(hmacSha256Verifier({ secret, header: 'x-sig' }));
    expect((await post(a, { 'x-sig': sign(body, 'hex') }, body.replace('p1', 'p2'))).status).toBe(401);
  });

  it('validates options at creation', () => {
    expect(() => hmacSha256Verifier({ secret: '', header: 'x-sig' })).toThrow(NornConfigError);
    expect(() => hmacSha256Verifier({ secret: new Uint8Array(), header: 'x-sig' })).toThrow(NornConfigError);
    expect(() => hmacSha256Verifier({ secret, header: '' })).toThrow(NornConfigError);
    expect(() => hmacSha256Verifier({ secret, header: 'x-sig', encoding: 'utf8' as never })).toThrow(NornConfigError);
    expect(() => hmacSha256Verifier({ secret: 42 as never, header: 'x-sig' })).toThrow(NornConfigError);
  });
});

describe('hmacSha256 and timingSafeEqual', () => {
  it('computes HMAC-SHA256 like node:crypto', async () => {
    const mac = await hmacSha256(secret, `1700000000.${body}`);
    expect(Buffer.from(mac).toString('hex')).toBe(sign(`1700000000.${body}`, 'hex'));
    const bytes = await hmacSha256(new TextEncoder().encode(secret), new TextEncoder().encode(body));
    expect(Buffer.from(bytes).toString('base64')).toBe(sign(body, 'base64'));
  });

  it('compares byte arrays', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
  });
});
