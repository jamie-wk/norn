/**
 * Small runtime-neutral helpers shared by the modules of this package.
 *
 * @internal
 */

/** Default response header carrying the correlation ID. */
export const DEFAULT_CORRELATION_HEADER = 'x-correlation-id';

/** Correlation IDs accepted from clients: 1–128 characters of `[A-Za-z0-9._:-]`. */
const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && VALID_ID.test(value);
}

/** An RFC 7230 header field name (token). */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function isHeaderName(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

/** Decodes standard or URL-safe base64, with or without padding. Returns undefined when invalid. */
export function decodeBase64(value: string): Uint8Array | undefined {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return undefined;
  try {
    return Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** Encodes bytes as standard, padded base64 (the proto3 JSON form of `bytes`). */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked, so large payloads neither blow the argument limit nor build strings byte by byte.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Sets a header on a response, copying the response first when its headers are immutable
 * (e.g. `Response.redirect()` or a proxied `fetch()` response). Responses that cannot be copied
 * either (such as a 101 WebSocket upgrade) are returned unchanged.
 */
export function withHeader(res: Response, name: string, value: string): Response {
  try {
    res.headers.set(name, value);
    return res;
  } catch {
    try {
      const copy = new Response(res.body, res);
      copy.headers.set(name, value);
      return copy;
    } catch {
      return res;
    }
  }
}

/** True for a positive safe integer, e.g. a byte limit. */
export const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/**
 * Reads a request body, stopping as soon as it exceeds `maxBytes` (a lying or missing
 * `content-length` doesn't help). Returns undefined when the body is too large.
 */
export async function readBody(req: Request, maxBytes: number): Promise<Uint8Array | undefined> {
  if (Number(req.headers.get('content-length')) > maxBytes) return undefined;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}
