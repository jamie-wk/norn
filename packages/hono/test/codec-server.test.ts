import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { defaultPayloadConverter, type Payload, type PayloadCodec } from '@temporalio/common';
import { clientDataConverter, createEncryptionCodec, generateKey } from '@norn-ts/codec';
import { NornConfigError } from '@norn-ts/core';
import { codecServer as codecServerFromIndex } from '../src/index.ts';
import { codecServer, type CodecServerOptions, type JsonPayload } from '../src/codec-server.ts';

const keys = { k1: generateKey(), k2: generateKey() };
const codec = createEncryptionCodec({ keys, currentKeyId: 'k1' });

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const toJson = (p: Payload): JsonPayload => ({
  metadata: Object.fromEntries(Object.entries(p.metadata ?? {}).map(([k, v]) => [k, b64(v!)])),
  data: b64(p.data ?? new Uint8Array()),
});
const fromJson = (p: JsonPayload): Payload => ({
  metadata: Object.fromEntries(Object.entries(p.metadata ?? {}).map(([k, v]) => [k, fromB64(v)])),
  data: fromB64(p.data ?? ''),
});
const plain = (value: unknown) => toJson(defaultPayloadConverter.toPayload(value));
const valueOf = (p: JsonPayload) => defaultPayloadConverter.fromPayload(fromJson(p));

function server(options: Partial<CodecServerOptions> = {}) {
  const app = new Hono();
  app.route('/codec', codecServer({ codec, auth: false, ...options }));
  return app;
}

const call = (app: Hono, op: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`/codec/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function payloadsOf(res: Response): Promise<JsonPayload[]> {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  return ((await res.json()) as { payloads: JsonPayload[] }).payloads;
}

describe('codecServer: encode and decode', () => {
  it('round-trips payloads through /encode and /decode', async () => {
    const app = server();
    const values = [{ orderId: 'o-1', total: 12.5 }, 'text', null, [1, 2, 3]];
    const encoded = await payloadsOf(await call(app, 'encode', { payloads: values.map(plain) }));
    expect(encoded).toHaveLength(4);
    for (const p of encoded) {
      expect(new TextDecoder().decode(fromB64(p.metadata!.encoding!))).toBe('binary/encrypted');
      expect(new TextDecoder().decode(fromB64(p.metadata!['encryption-key-id']!))).toBe('k1');
    }
    const decoded = await payloadsOf(await call(app, 'decode', { payloads: encoded }));
    expect(decoded.map(valueOf)).toEqual(values);
    expect(decoded).toEqual(values.map(plain));
  });

  it('decodes payloads encrypted by clientDataConverter', async () => {
    const converter = clientDataConverter({ keys, currentKeyId: 'k2' });
    const input = { customerId: 'c-1', amountCents: 1999, at: '2026-10-19' };
    const encrypted = await converter.payloadCodecs[0]!.encode([converter.payloadConverter.toPayload(input)]);
    const decoded = await payloadsOf(await call(server(), 'decode', { payloads: encrypted.map(toJson) }));
    expect(converter.payloadConverter.fromPayload(fromJson(decoded[0]!))).toEqual(input);
  });

  it('passes through unencrypted payloads on decode', async () => {
    const decoded = await payloadsOf(await call(server(), 'decode', { payloads: [plain('already plain')] }));
    expect(valueOf(decoded[0]!)).toBe('already plain');
  });

  it('applies codecs in order on encode and in reverse on decode', async () => {
    const log: string[] = [];
    const tracing = (name: string, inner: PayloadCodec): PayloadCodec => ({
      encode: (p) => (log.push(`${name}.encode`), inner.encode(p)),
      decode: (p) => (log.push(`${name}.decode`), inner.decode(p)),
    });
    const inner = tracing('inner', createEncryptionCodec({ keys: { a: keys.k1 }, currentKeyId: 'a' }));
    const outer = tracing('outer', createEncryptionCodec({ keys: { b: keys.k2 }, currentKeyId: 'b' }));
    const app = server({ codec: [inner, outer] });
    const encoded = await payloadsOf(await call(app, 'encode', { payloads: [plain(42)] }));
    expect(new TextDecoder().decode(fromB64(encoded[0]!.metadata!['encryption-key-id']!))).toBe('b');
    const decoded = await payloadsOf(await call(app, 'decode', { payloads: encoded }));
    expect(valueOf(decoded[0]!)).toBe(42);
    expect(log).toEqual(['inner.encode', 'outer.encode', 'outer.decode', 'inner.decode']);
  });

  it('handles empty batches and payloads without metadata or data', async () => {
    const app = server();
    expect(await payloadsOf(await call(app, 'decode', { payloads: [] }))).toEqual([]);
    const decoded = await payloadsOf(await call(app, 'decode', { payloads: [{}] }));
    expect(decoded).toEqual([{ metadata: {}, data: '' }]);
  });

  it('accepts URL-safe and unpadded base64', async () => {
    const p = plain({ q: '??>>' });
    const urlSafe = { metadata: { encoding: p.metadata!.encoding!.replace(/=+$/, '') }, data: p.data!.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
    const decoded = await payloadsOf(await call(server(), 'decode', { payloads: [urlSafe] }));
    expect(valueOf(decoded[0]!)).toEqual({ q: '??>>' });
  });

  it('round-trips large binary payloads', async () => {
    const big = new Uint8Array(300_000).map((_, i) => (i * 7) % 256);
    const payload = toJson(defaultPayloadConverter.toPayload(big));
    const app = server();
    const encoded = await payloadsOf(await call(app, 'encode', { payloads: [payload] }));
    const decoded = await payloadsOf(await call(app, 'decode', { payloads: encoded }));
    expect(decoded[0]).toEqual(payload);
  });

  it('is exported from the package index too', () => {
    expect(codecServerFromIndex).toBe(codecServer);
  });
});

describe('codecServer: sad paths', () => {
  it.each([
    ['not JSON', '{"payloads":'],
    ['no payloads', {}],
    ['payloads not an array', { payloads: {} }],
    ['payload not an object', { payloads: ['x'] }],
    ['payload is null', { payloads: [null] }],
    ['metadata not an object', { payloads: [{ metadata: 'x' }] }],
    ['metadata value not a string', { payloads: [{ metadata: { encoding: 1 } }] }],
    ['metadata value not base64', { payloads: [{ metadata: { encoding: '!!' } }] }],
    ['data not a string', { payloads: [{ data: 12 }] }],
    ['data not base64', { payloads: [{ data: 'a b c' }] }],
    ['body is an array', []],
  ])('rejects a bad body (%s) with 400', async (_label, body) => {
    const res = await call(server(), 'decode', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_PAYLOADS' } });
  });

  it('reports codec failures without echoing payload contents', async () => {
    const onError = vi.fn();
    const other = createEncryptionCodec({ keys: { k1: generateKey() }, currentKeyId: 'k1' });
    const [secretPayload] = await other.encode([defaultPayloadConverter.toPayload('top secret value')]);
    const json = toJson(secretPayload!);
    const res = await call(server({ onError }), 'decode', { payloads: [json] });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(json.data);
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'CODEC_FAILED', message: expect.stringContaining('could not be decrypted') } });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0].name).toBe('NornCodecError');
  });

  it('hides unexpected codec errors behind a generic 500', async () => {
    const broken: PayloadCodec = { encode: async () => [], decode: async () => Promise.reject(new Error('internal detail')) };
    const res = await call(server({ codec: broken }), 'decode', { payloads: [plain(1)] });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('internal detail');
  });

  it('rejects a codec returning the wrong number of payloads', async () => {
    const broken: PayloadCodec = { encode: async () => [], decode: async () => [] };
    const res = await call(server({ codec: broken }), 'encode', { payloads: [plain(1)] });
    expect(res.status).toBe(500);
  });

  it('rejects bodies over maxBodyBytes with 413 before decoding', async () => {
    const decode = vi.fn(async (p: Payload[]) => p);
    const app = server({ codec: { encode: async (p) => p, decode }, maxBodyBytes: 64 });
    const res = await call(app, 'decode', { payloads: [plain('x'.repeat(200))] });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(decode).not.toHaveBeenCalled();
  });

  it('keeps a metadata key named __proto__', async () => {
    const app = server({ codec: { encode: async (p) => p, decode: async (p) => p } });
    const res = await call(app, 'decode', '{"payloads":[{"metadata":{"__proto__":"eA=="},"data":""}]}');
    const [payload] = await payloadsOf(res);
    expect(Object.keys(payload!.metadata!)).toEqual(['__proto__']);
  });

  it('only serves POST /encode and /decode', async () => {
    const app = server();
    expect((await app.request('/codec/decode')).status).toBe(404);
    expect((await call(app, 'other', { payloads: [] })).status).toBe(404);
  });

  it('validates options at creation', () => {
    expect(() => codecServer({} as never)).toThrow(NornConfigError);
    expect(() => codecServer({ codec: {} as never, auth: false })).toThrow(NornConfigError);
    expect(() => codecServer({ codec: [], auth: false })).toThrow(NornConfigError);
    expect(() => codecServer({ codec } as never)).toThrow(/`auth` is required/);
    expect(() => codecServer({ codec, auth: false, maxBodyBytes: 0 })).toThrow(NornConfigError);
    expect(() => codecServer({ codec, auth: false, cors: { origins: 'https://x' as never } })).toThrow(NornConfigError);
    expect(() => codecServer({ codec, auth: false, cors: { origins: ['not a url'] } })).toThrow(NornConfigError);
    expect(() => codecServer({ codec, auth: false, namespaces: 'default' as never })).toThrow(NornConfigError);
    expect(() => codecServer({ codec, auth: false, namespaces: [] })).toThrow(NornConfigError);
    expect(() => codecServer({ codec, auth: true as never })).toThrow(NornConfigError);
  });
});

describe('codecServer: auth and namespaces', () => {
  const auth = (c: { req: { header: (n: string) => string | undefined } }) => c.req.header('authorization') === 'Bearer good';

  it('rejects unauthenticated calls with 401', async () => {
    const app = server({ auth });
    const res = await call(app, 'decode', { payloads: [] }, { authorization: 'Bearer bad' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect((await call(app, 'decode', { payloads: [] })).status).toBe(401);
    expect((await call(app, 'decode', { payloads: [] }, { authorization: 'Bearer good' })).status).toBe(200);
  });

  it('supports async auth and treats a throwing auth as unauthenticated', async () => {
    expect((await call(server({ auth: async () => true }), 'decode', { payloads: [] })).status).toBe(200);
    const throwing = server({
      auth: () => {
        throw new Error('jwks down');
      },
    });
    expect((await call(throwing, 'decode', { payloads: [] })).status).toBe(401);
  });

  it('authenticates before reading the body', async () => {
    expect((await call(server({ auth: () => false }), 'decode', 'garbage')).status).toBe(401);
  });

  it('checks X-Namespace against the allowed namespaces', async () => {
    const app = server({ namespaces: ['orders-prod', 'orders-staging'] });
    expect((await call(app, 'decode', { payloads: [] }, { 'x-namespace': 'orders-prod' })).status).toBe(200);
    const wrong = await call(app, 'decode', { payloads: [] }, { 'x-namespace': 'payments' });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ error: { code: 'FORBIDDEN_NAMESPACE' } });
    expect((await call(app, 'decode', { payloads: [] })).status).toBe(403);
  });

  it('ignores X-Namespace when no namespaces are configured', async () => {
    expect((await call(server(), 'decode', { payloads: [] }, { 'x-namespace': 'anything' })).status).toBe(200);
  });
});

describe('codecServer: CORS', () => {
  const preflight = (app: Hono, origin: string, path = '/codec/decode') =>
    app.request(path, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-namespace,authorization' },
    });

  it('answers preflight for the default origins', async () => {
    const app = server({ auth: () => false });
    for (const origin of ['https://cloud.temporal.io', 'http://localhost:8233']) {
      for (const path of ['/codec/decode', '/codec/encode']) {
        const res = await preflight(app, origin, path);
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe(origin);
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
        expect(res.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
        expect(res.headers.get('access-control-allow-headers')).toBe('content-type, x-namespace, authorization');
        expect(res.headers.get('access-control-max-age')).toBe('600');
        expect(res.headers.get('vary')).toMatch(/origin/i);
      }
    }
  });

  it('refuses preflight and requests from other origins', async () => {
    const app = server();
    const res = await preflight(app, 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const post = await call(app, 'decode', { payloads: [] }, { origin: 'https://evil.example' });
    expect(post.status).toBe(403);
    expect(post.headers.get('access-control-allow-origin')).toBeNull();
    expect(await post.json()).toMatchObject({ error: { code: 'FORBIDDEN_ORIGIN' } });
  });

  it('sets CORS headers on responses for allowed origins, including errors', async () => {
    const app = server({ auth: () => false });
    const res = await call(app, 'decode', { payloads: [] }, { origin: 'https://cloud.temporal.io' });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://cloud.temporal.io');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('allows requests without an Origin (temporal CLI) and adds no CORS headers', async () => {
    const res = await call(server(), 'decode', { payloads: [] });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('uses custom origins (exact match, trailing slash ignored)', async () => {
    const app = server({ cors: { origins: ['https://temporal.internal.example.com/'] } });
    expect((await preflight(app, 'https://temporal.internal.example.com')).status).toBe(204);
    expect((await preflight(app, 'https://cloud.temporal.io')).status).toBe(403);
    expect((await preflight(app, 'https://temporal.internal.example.com.evil.io')).status).toBe(403);
  });

  it('allows any origin with "*", without credentials', async () => {
    const res = await preflight(server({ cors: { origins: ['*'] } }), 'https://anything.example');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('turns CORS off with cors: false', async () => {
    const app = server({ cors: false });
    expect((await preflight(app, 'https://cloud.temporal.io')).status).toBe(404);
    const res = await call(app, 'decode', { payloads: [] }, { origin: 'https://cloud.temporal.io' });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
