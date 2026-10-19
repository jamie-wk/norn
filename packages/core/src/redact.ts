export const REDACTED = '[REDACTED]';

/** Keys whose values are never logged: credentials, TLS material and payload bodies. */
export const DEFAULT_REDACT_KEYS: readonly string[] = Object.freeze([
  'apiKey',
  'authorization',
  'password',
  'passwd',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'privateKey',
  'clientCertPair',
  'serverRootCACertificate',
  'crt',
  'key',
  'cookie',
  'payload',
  'payloads',
]);

const normalize = (key: string) => key.replace(/[-_\s]/g, '').toLowerCase();

/**
 * Returns a deep copy of `value` with sensitive values replaced by {@link REDACTED}. Never mutates
 * the input, tolerates cycles, and summarizes binary data instead of dumping it.
 */
export function redact<T>(value: T, extraKeys: readonly string[] = []): T {
  const keys = new Set([...DEFAULT_REDACT_KEYS, ...extraKeys].map(normalize));
  const seen = new WeakSet<object>();

  const walk = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input;
    if (ArrayBuffer.isView(input)) return `[Binary ${input.byteLength} bytes]`;
    if (input instanceof ArrayBuffer) return `[Binary ${input.byteLength} bytes]`;
    if (input instanceof Date) return new Date(input.getTime());
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    if (Array.isArray(input)) {
      const out = input.map(walk);
      seen.delete(input);
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = keys.has(normalize(k)) ? REDACTED : walk(v);
    }
    seen.delete(input);
    return out;
  };

  return walk(value) as T;
}
