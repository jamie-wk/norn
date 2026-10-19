import { describe, expect, it } from 'vitest';
import { redact, REDACTED } from '../src/index.ts';

describe('redact', () => {
  it('replaces sensitive keys at any depth, case- and separator-insensitively', () => {
    const input = {
      address: 'temporal:7233',
      apiKey: 'k',
      tls: { clientCertPair: { crt: 'c', key: 'k' } },
      headers: { Authorization: 'Bearer x', 'x-request-id': 'r1' },
      nested: [{ PASSWORD: 'p', access_token: 't' }],
    };
    expect(redact(input)).toEqual({
      address: 'temporal:7233',
      apiKey: REDACTED,
      tls: { clientCertPair: REDACTED },
      headers: { Authorization: REDACTED, 'x-request-id': 'r1' },
      nested: [{ PASSWORD: REDACTED, access_token: REDACTED }],
    });
  });

  it('never mutates the input', () => {
    const input = { password: 'p' };
    redact(input);
    expect(input.password).toBe('p');
  });

  it('accepts extra keys', () => {
    expect(redact({ ssn: '123', name: 'a' }, ['ssn'])).toEqual({ ssn: REDACTED, name: 'a' });
  });

  it('handles cycles and binary data', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redact(a)).toEqual({ name: 'a', self: '[Circular]' });
    expect(redact({ data: new Uint8Array(12) })).toEqual({ data: '[Binary 12 bytes]' });
  });

  it('redacts payload bodies', () => {
    expect(redact({ payloads: [{ data: 'secret' }] })).toEqual({ payloads: REDACTED });
  });

  it('passes primitives through', () => {
    expect(redact('x')).toBe('x');
    expect(redact(3)).toBe(3);
    expect(redact(null)).toBe(null);
  });
});
