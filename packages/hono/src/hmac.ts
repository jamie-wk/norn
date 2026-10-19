import type { Context } from 'hono';
import { NornConfigError } from '@norn/core';
import { decodeBase64, isHeaderName } from './internal.js';

type ImportedKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

const utf8 = new TextEncoder();
const toBytes = (value: string | Uint8Array): Uint8Array<ArrayBuffer> =>
  typeof value === 'string' ? utf8.encode(value) : new Uint8Array(value);

const importHmacKey = (secret: Uint8Array<ArrayBuffer>) =>
  globalThis.crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

/** HMAC-SHA256 of `data` (UTF-8 when a string) with `secret`, using WebCrypto. */
export async function hmacSha256(secret: string | Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const key = await importHmacKey(toBytes(secret));
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, toBytes(data)));
}

/**
 * Compares two byte arrays in time that depends only on their lengths, not their contents.
 * Use it to compare signatures; `===` on strings leaks how many leading characters matched.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function decodeHex(value: string): Uint8Array | undefined {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) return undefined;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export interface HmacSha256VerifierOptions {
  /** The shared webhook secret. Strings are used as UTF-8 bytes. */
  secret: string | Uint8Array;
  /** Request header carrying the signature, e.g. `x-hub-signature-256`. */
  header: string;
  /** How the signature is encoded in the header. Default `'hex'` (either case). `'base64'` also accepts URL-safe and unpadded. */
  encoding?: 'hex' | 'base64';
  /** A prefix the header value must start with, e.g. `'sha256='` (GitHub). */
  prefix?: string;
}

/**
 * A `verify` function for {@link temporalWebhook} that checks an HMAC-SHA256 signature of the
 * raw request body sent in a header (GitHub, Shopify, many payment providers). Uses WebCrypto
 * and a constant-time comparison; missing or malformed signatures fail verification.
 *
 * @example
 * ```ts
 * verify: hmacSha256Verifier({ secret: env.GITHUB_WEBHOOK_SECRET, header: 'x-hub-signature-256', prefix: 'sha256=' })
 * ```
 */
export function hmacSha256Verifier(options: HmacSha256VerifierOptions): (c: Context, rawBody: string, rawBytes?: Uint8Array) => Promise<boolean> {
  const { secret, header, encoding = 'hex', prefix = '' } = options ?? ({} as HmacSha256VerifierOptions);
  if (typeof secret !== 'string' && !(secret instanceof Uint8Array)) {
    throw new NornConfigError('hmacSha256Verifier: secret must be a string or a Uint8Array');
  }
  if (secret.length === 0) throw new NornConfigError('hmacSha256Verifier: secret must not be empty');
  if (!isHeaderName(header)) throw new NornConfigError('hmacSha256Verifier: header must be a valid header name');
  if (encoding !== 'hex' && encoding !== 'base64') throw new NornConfigError("hmacSha256Verifier: encoding must be 'hex' or 'base64'");
  if (typeof prefix !== 'string') throw new NornConfigError('hmacSha256Verifier: prefix must be a string');

  // Copy now, so later changes to the caller's array cannot change the secret.
  const secretBytes = toBytes(secret);
  let key: Promise<ImportedKey> | undefined;

  return async (c, rawBody, rawBytes) => {
    const value = c.req.header(header)?.trim();
    if (!value || !value.startsWith(prefix)) return false;
    const encoded = value.slice(prefix.length);
    const signature = encoding === 'hex' ? decodeHex(encoded) : decodeBase64(encoded);
    if (!signature || signature.length === 0) return false;
    key ??= importHmacKey(secretBytes);
    const expected = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', await key, rawBytes ? new Uint8Array(rawBytes) : utf8.encode(rawBody)));
    return timingSafeEqual(expected, signature);
  };
}
