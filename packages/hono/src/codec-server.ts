/**
 * A Temporal codec server (the protocol the Temporal UI and `temporal` CLI use to decode
 * payloads), as a Hono sub-app.
 *
 * This module depends only on hono and `@norn-ts/core`, not on the Temporal client, so it can run on
 * edge runtimes. Import it as `@norn-ts/hono/codec-server` there.
 *
 * @module
 */
import { Hono, type Context, type Env } from 'hono';
import type { Payload, PayloadCodec } from '@temporalio/common';
import { NornConfigError, NornError } from '@norn-ts/core';
import type { NornErrorCode } from './errors.js';
import { DEFAULT_CORRELATION_HEADER, decodeBase64, encodeBase64, errorBody, isPlainObject, isPositiveInteger, readBody } from './internal.js';

/** A payload in proto3 JSON form, as the codec server protocol sends it: bytes are base64. */
export interface JsonPayload {
  metadata?: Record<string, string>;
  data?: string;
}

export interface CodecServerOptions<E extends Env = any> {
  /** The codec, or codecs in the order your data converter applies them. */
  codec: PayloadCodec | PayloadCodec[];
  /**
   * Authenticates the caller, e.g. by checking `Authorization: Bearer <token>`. Returning false
   * or throwing → 401. Required: anyone who passes can decrypt your payloads. Pass `false` only
   * when something in front of the server (a gateway, a private network) already authenticates.
   */
  auth: ((c: Context<E>) => boolean | Promise<boolean>) | false;
  /**
   * Browser origins allowed to call the server (the Temporal UI). Default
   * `['https://cloud.temporal.io', 'http://localhost:8233']`; `'*'` allows any origin. `false`
   * turns CORS handling off (no preflight responses and no origin checks), e.g. for CLI-only use.
   * Named origins are allowed with credentials (cookies); `'*'` is not.
   */
  cors?: { origins: string[] } | false;
  /** Largest request body accepted; bigger ones → 413. Default 16 MiB. */
  maxBodyBytes?: number;
  /** Namespaces (from the `X-Namespace` header) the server may be used for. Others → 403. */
  namespaces?: string[];
  /**
   * Called with errors from `auth` and the codecs, e.g. for logging. Payload contents are never
   * passed to it, and errors from Norn's encryption codec never contain them.
   */
  onError?: (err: unknown, c: Context<E>) => void;
}

export const DEFAULT_CODEC_ORIGINS: readonly string[] = Object.freeze(['https://cloud.temporal.io', 'http://localhost:8233']);
const ALLOW_HEADERS = 'content-type, x-namespace, authorization';
const ALLOW_METHODS = 'POST, OPTIONS';
const MAX_AGE = '600';
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

class BadPayloadsError extends Error {}

const isCodec = (value: unknown): value is PayloadCodec =>
  typeof value === 'object' && value !== null && typeof (value as PayloadCodec).encode === 'function' && typeof (value as PayloadCodec).decode === 'function';

function normalizeOrigin(origin: string): string {
  if (origin === '*') return origin;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new NornConfigError(`codecServer: CORS origin ${JSON.stringify(origin)} is not a URL like https://temporal.example.com`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new NornConfigError(`codecServer: CORS origin ${JSON.stringify(origin)} must be http(s)`);
  return url.origin;
}

function bytesOf(value: unknown, where: string): Uint8Array {
  if (typeof value !== 'string') throw new BadPayloadsError(`${where} must be a base64 string`);
  const bytes = decodeBase64(value);
  if (!bytes) throw new BadPayloadsError(`${where} is not valid base64`);
  return bytes;
}

function parsePayloads(body: unknown): Payload[] {
  if (!isPlainObject(body) || !Array.isArray(body.payloads)) throw new BadPayloadsError('Body must be { "payloads": [...] }');
  return body.payloads.map((p: unknown, i: number): Payload => {
    if (!isPlainObject(p)) throw new BadPayloadsError(`payloads[${i}] must be an object`);
    // Null prototype: a "__proto__" key from JSON.parse must stay a plain key.
    const metadata: Record<string, Uint8Array> = Object.create(null);
    if (p.metadata !== undefined && p.metadata !== null) {
      if (!isPlainObject(p.metadata)) throw new BadPayloadsError(`payloads[${i}].metadata must be an object`);
      for (const [key, value] of Object.entries(p.metadata)) metadata[key] = bytesOf(value, `payloads[${i}].metadata.${key}`);
    }
    const data = p.data === undefined || p.data === null ? new Uint8Array() : bytesOf(p.data, `payloads[${i}].data`);
    return { metadata, data };
  });
}

function toJsonPayload(p: Payload): JsonPayload {
  const metadata: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(p.metadata ?? {})) if (value) metadata[key] = encodeBase64(value);
  return { metadata, data: encodeBase64(p.data ?? new Uint8Array()) };
}

/**
 * Creates a Temporal codec server: `POST /encode` and `POST /decode` with
 * `{ payloads: [{ metadata: { key: base64 }, data: base64 }] }`, answering with the same shape.
 * Decoding applies the codecs in reverse order, encoding in order, as Temporal SDKs do.
 *
 * Mount it with `app.route('/codec', codecServer({ codec, auth }))` and point the Temporal UI or
 * CLI (`--codec-endpoint`) at `https://your-api/codec`.
 *
 * @example
 * ```ts
 * app.route('/codec', codecServer({
 *   codec: createEncryptionCodec({ keys, currentKeyId: '2026-10' }),
 *   auth: (c) => c.req.header('authorization') === `Bearer ${env.CODEC_TOKEN}`,
 *   namespaces: ['orders-prod'],
 * }));
 * ```
 */
export function codecServer<E extends Env = any>(options: CodecServerOptions<E>): Hono<E> {
  if (typeof options !== 'object' || options === null) throw new NornConfigError('codecServer: options with a `codec` are required');
  const codecs = Array.isArray(options.codec) ? [...options.codec] : [options.codec];
  if (codecs.length === 0 || !codecs.every(isCodec)) {
    throw new NornConfigError('codecServer: `codec` must be a PayloadCodec ({ encode, decode }) or a non-empty array of them');
  }
  const { auth, onError, maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = options;
  if (auth === undefined) throw new NornConfigError('codecServer: `auth` is required (a function, or false when something in front already authenticates)');
  if (auth !== false && typeof auth !== 'function') throw new NornConfigError('codecServer: `auth` must be a function or false');
  if (!isPositiveInteger(maxBodyBytes)) throw new NornConfigError('codecServer: `maxBodyBytes` must be a positive integer');
  if (onError !== undefined && typeof onError !== 'function') throw new NornConfigError('codecServer: `onError` must be a function');

  let origins: Set<string> | undefined;
  if (options.cors !== false) {
    const list = options.cors === undefined ? DEFAULT_CODEC_ORIGINS : options.cors?.origins;
    if (!Array.isArray(list) || !list.every((o) => typeof o === 'string')) {
      throw new NornConfigError('codecServer: `cors.origins` must be an array of origins');
    }
    origins = new Set(list.map(normalizeOrigin));
  }

  let namespaces: Set<string> | undefined;
  if (options.namespaces !== undefined) {
    if (!Array.isArray(options.namespaces) || options.namespaces.length === 0 || !options.namespaces.every((n) => typeof n === 'string' && n !== '')) {
      throw new NornConfigError('codecServer: `namespaces` must be a non-empty array of namespace names');
    }
    namespaces = new Set(options.namespaces);
  }

  const report = (err: unknown, c: Context<E>) => {
    try {
      onError?.(err, c);
    } catch {
      // Logging must not change the response.
    }
  };
  const fail = (c: Context<E>, status: 400 | 401 | 403 | 413 | 500, code: NornErrorCode, message: string) => {
    const id = globalThis.crypto.randomUUID();
    c.header(DEFAULT_CORRELATION_HEADER, id);
    return c.json(errorBody(new NornError(code, status, message), id), status);
  };

  const app = new Hono<E>();

  if (origins) {
    // CORS: answered before auth, because browsers send preflights without credentials.
    app.use('*', async (c, next) => {
      const origin = c.req.header('origin');
      if (origin !== undefined && !origins.has('*') && !origins.has(origin)) {
        c.header('vary', 'Origin');
        return fail(c, 403, 'FORBIDDEN_ORIGIN', 'Origin is not allowed');
      }
      if (origin !== undefined && origins.has('*')) {
        // A wildcard never comes with credentials, or any site could read decrypted payloads with the user's cookies.
        c.header('access-control-allow-origin', '*');
      } else if (origin !== undefined) {
        c.header('access-control-allow-origin', origin);
        c.header('access-control-allow-credentials', 'true');
        c.header('vary', 'Origin');
      }
      if (c.req.method === 'OPTIONS') {
        c.header('access-control-allow-methods', ALLOW_METHODS);
        c.header('access-control-allow-headers', ALLOW_HEADERS);
        c.header('access-control-max-age', MAX_AGE);
        return c.body(null, 204);
      }
      await next();
    });
  }

  const run = async (c: Context<E>, operation: 'encode' | 'decode') => {
    if (auth) {
      let ok = false;
      try {
        ok = (await auth(c)) === true;
      } catch (error) {
        report(error, c);
      }
      if (!ok) return fail(c, 401, 'UNAUTHORIZED', 'Unauthorized');
    }
    if (namespaces) {
      const namespace = c.req.header('x-namespace');
      if (namespace === undefined || !namespaces.has(namespace)) return fail(c, 403, 'FORBIDDEN_NAMESPACE', 'Namespace is not allowed');
    }

    const body = await readBody(c.req.raw, maxBodyBytes);
    if (!body) return fail(c, 413, 'PAYLOAD_TOO_LARGE', `Body is larger than ${maxBodyBytes} bytes`);
    let payloads: Payload[];
    try {
      payloads = parsePayloads(JSON.parse(new TextDecoder().decode(body)));
    } catch (error) {
      return fail(c, 400, 'INVALID_PAYLOADS', error instanceof BadPayloadsError ? error.message : 'Body is not valid JSON');
    }

    try {
      const ordered = operation === 'encode' ? codecs : [...codecs].reverse();
      for (const codec of ordered) {
        const out = await codec[operation](payloads);
        if (!Array.isArray(out) || out.length !== payloads.length) {
          throw new Error(`codec ${operation} returned ${Array.isArray(out) ? out.length : 'no'} payloads for ${payloads.length}`);
        }
        payloads = out;
      }
      return c.json({ payloads: payloads.map(toJsonPayload) });
    } catch (error) {
      report(error, c);
      // Norn codec errors are written to be safe to show (key ids, never key material or data).
      if (error instanceof Error && error.name === 'NornCodecError') return fail(c, 400, 'CODEC_FAILED', error.message);
      return fail(c, 500, 'INTERNAL', `Payloads could not be ${operation}d`);
    }
  };

  app.post('/encode', (c) => run(c, 'encode'));
  app.post('/decode', (c) => run(c, 'decode'));
  return app;
}
