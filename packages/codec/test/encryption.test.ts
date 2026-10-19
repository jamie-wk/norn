import { describe, expect, it } from 'vitest';
import type { Payload } from '@temporalio/common';
import { createEncryptionCodec, generateKey, NornCodecError } from '../src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

const keyA = generateKey();
const keyB = generateKey();

function jsonPayload(value: unknown): Payload {
  return { metadata: { encoding: enc.encode('json/plain') }, data: enc.encode(JSON.stringify(value)) };
}

const meta = (p: Payload, key: string) => dec.decode(p.metadata?.[key] ?? new Uint8Array());

/** Every textual form a key could leak in. */
function keyForms(base64: string): string[] {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return [base64, Buffer.from(bytes).toString('hex'), Array.from(bytes).join(','), bytes.toString()];
}

async function captureError(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected an error');
}

function expectNoKeyMaterial(error: unknown, ...keys: string[]) {
  const text = `${String(error)} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
  for (const key of keys) for (const form of keyForms(key)) expect(text).not.toContain(form);
}

describe('generateKey', () => {
  it('returns base64 for 32 random bytes', () => {
    const key = generateKey();
    expect(atob(key)).toHaveLength(32);
    expect(generateKey()).not.toBe(key);
  });
});

describe('createEncryptionCodec', () => {
  it('round-trips payloads, including metadata and empty data', async () => {
    const codec = createEncryptionCodec({ keys: { a: keyA }, currentKeyId: 'a' });
    const inputs: Payload[] = [
      jsonPayload({ hello: 'world', n: 1 }),
      { metadata: { encoding: enc.encode('binary/null') } },
      { metadata: { encoding: enc.encode('binary/plain'), extra: new Uint8Array([0, 255]) }, data: new Uint8Array(0) },
    ];
    const encoded = await codec.encode(inputs);
    expect(encoded).toHaveLength(3);
    for (const p of encoded) {
      expect(meta(p, 'encoding')).toBe('binary/encrypted');
      expect(meta(p, 'encryption-key-id')).toBe('a');
    }
    const decoded = await codec.decode(encoded);
    expect(decoded[0]).toEqual(inputs[0]);
    expect(meta(decoded[1]!, 'encoding')).toBe('binary/null');
    expect(decoded[1]!.data ?? new Uint8Array()).toHaveLength(0);
    expect(decoded[2]!.metadata?.extra).toEqual(new Uint8Array([0, 255]));
  });

  it('handles an empty batch', async () => {
    const codec = createEncryptionCodec({ keys: { a: keyA }, currentKeyId: 'a' });
    expect(await codec.encode([])).toEqual([]);
    expect(await codec.decode([])).toEqual([]);
  });

  it('never leaves plaintext in the encoded payload', async () => {
    const codec = createEncryptionCodec({ keys: { a: keyA }, currentKeyId: 'a' });
    const [encoded] = await codec.encode([jsonPayload({ secret: 'super-secret-value' })]);
    expect(Buffer.from(encoded!.data!).toString('latin1')).not.toContain('super-secret-value');
    expect(Buffer.from(encoded!.data!).toString('latin1')).not.toContain('json/plain');
  });

  it('uses a fresh 12-byte IV for every payload', async () => {
    const codec = createEncryptionCodec({ keys: { a: keyA }, currentKeyId: 'a' });
    const input = jsonPayload('same');
    const [one, two] = await codec.encode([input, input]);
    const [three] = await codec.encode([input]);
    const ivs = [one, two, three].map((p) => Buffer.from(p!.data!.subarray(0, 12)).toString('hex'));
    expect(new Set(ivs).size).toBe(3);
    expect(Buffer.from(one!.data!).equals(Buffer.from(two!.data!))).toBe(false);
  });

  it('accepts raw Uint8Array keys', async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const codec = createEncryptionCodec({ keys: { raw }, currentKeyId: 'raw' });
    const decoded = await codec.decode(await codec.encode([jsonPayload(42)]));
    expect(decoded[0]).toEqual(jsonPayload(42));
  });

  it('passes unencrypted payloads through decode untouched', async () => {
    const codec = createEncryptionCodec({ keys: { a: keyA }, currentKeyId: 'a' });
    const plain = jsonPayload({ legacy: true });
    const noMetadata: Payload = { data: enc.encode('x') };
    const [out1, out2] = await codec.decode([plain, noMetadata]);
    expect(out1).toBe(plain);
    expect(out2).toBe(noMetadata);
  });

  it('decodes payloads written with an older key after rotation', async () => {
    const before = createEncryptionCodec({ keys: { a: keyA }, currentKeyId: 'a' });
    const old = await before.encode([jsonPayload('written with a')]);

    const after = createEncryptionCodec({ keys: { a: keyA, b: keyB }, currentKeyId: 'b' });
    const fresh = await after.encode([jsonPayload('written with b')]);
    expect(meta(fresh[0]!, 'encryption-key-id')).toBe('b');

    const decoded = await after.decode([...old, ...fresh]);
    expect(decoded).toEqual([jsonPayload('written with a'), jsonPayload('written with b')]);
  });

  it('fails clearly on an unknown key id', async () => {
    const writer = createEncryptionCodec({ keys: { retired: keyA }, currentKeyId: 'retired' });
    const encoded = await writer.encode([jsonPayload(1)]);
    const reader = createEncryptionCodec({ keys: { b: keyB }, currentKeyId: 'b' });
    const error = await captureError(() => reader.decode(encoded));
    expect(error).toBeInstanceOf(NornCodecError);
    expect((error as Error).message).toContain('retired');
    expectNoKeyMaterial(error, keyA, keyB);
  });

  it('fails when an encrypted payload has no key id', async () => {
    const codec = createEncryptionCodec({ keys: { a: keyA }, currentKeyId: 'a' });
    const [encoded] = await codec.encode([jsonPayload(1)]);
    const { 'encryption-key-id': _drop, ...rest } = encoded!.metadata!;
    await expect(codec.decode([{ ...encoded, metadata: rest }])).rejects.toThrow(NornCodecError);
  });

  it('fails clearly on tampered ciphertext', async () => {
    const codec = createEncryptionCodec({ keys: { a: keyA }, currentKeyId: 'a' });
    const [encoded] = await codec.encode([jsonPayload({ amount: 100 })]);
    const data = new Uint8Array(encoded!.data!);
    data[data.length - 20] = data[data.length - 20]! ^ 0x01;
    const error = await captureError(() => codec.decode([{ ...encoded, data }]));
    expect(error).toBeInstanceOf(NornCodecError);
    expect((error as Error).message).toMatch(/could not be decrypted/);
    expectNoKeyMaterial(error, keyA);
  });

  it('fails on truncated data', async () => {
    const codec = createEncryptionCodec({ keys: { a: keyA }, currentKeyId: 'a' });
    const [encoded] = await codec.encode([jsonPayload(1)]);
    await expect(codec.decode([{ ...encoded, data: encoded!.data!.subarray(0, 10) }])).rejects.toThrow(/could not be decrypted/);
  });

  it('binds the key id as additional authenticated data', async () => {
    // Same key material under two ids: only the AAD can tell them apart.
    const codec = createEncryptionCodec({ keys: { a: keyA, alias: keyA }, currentKeyId: 'a' });
    const [encoded] = await codec.encode([jsonPayload('bound')]);
    const swapped: Payload = { ...encoded, metadata: { ...encoded!.metadata, 'encryption-key-id': enc.encode('alias') } };
    await expect(codec.decode([swapped])).rejects.toThrow(/could not be decrypted/);
    expect(await codec.decode([encoded!])).toEqual([jsonPayload('bound')]);
  });

  it('rejects keys that are not 32 bytes, naming the key id but not the key', () => {
    const short = btoa('x'.repeat(16));
    const error = (() => {
      try {
        createEncryptionCodec({ keys: { good: keyA, tooShort: short }, currentKeyId: 'good' });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(NornCodecError);
    expect((error as Error).message).toContain('tooShort');
    expect((error as Error).message).toContain('32 bytes');
    expectNoKeyMaterial(error, short, keyA);

    expect(() => createEncryptionCodec({ keys: { raw: new Uint8Array(31) }, currentKeyId: 'raw' })).toThrow(/raw/);
  });

  it('rejects keys that are not valid base64', () => {
    const bad = '!!!not base64!!!';
    let error: unknown;
    try {
      createEncryptionCodec({ keys: { k: bad }, currentKeyId: 'k' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NornCodecError);
    expect((error as Error).message).toContain('"k"');
    expect((error as Error).message).not.toContain(bad);
  });

  it('requires currentKeyId to name a configured key', () => {
    expect(() => createEncryptionCodec({ keys: { a: keyA }, currentKeyId: 'missing' })).toThrow(NornCodecError);
    expect(() => createEncryptionCodec({ keys: { a: keyA }, currentKeyId: 'missing' })).toThrow(/missing/);
    expect(() => createEncryptionCodec({ keys: {}, currentKeyId: 'a' })).toThrow(NornCodecError);
  });

  it('does not expose key material on the codec object', () => {
    const codec = createEncryptionCodec({ keys: { a: keyA }, currentKeyId: 'a' });
    const text = JSON.stringify(codec) + String(Object.values(codec));
    for (const form of keyForms(keyA)) expect(text).not.toContain(form);
  });

  it('copies key bytes so later mutation of the caller array has no effect', async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const codec = createEncryptionCodec({ keys: { raw }, currentKeyId: 'raw' });
    const encoded = await codec.encode([jsonPayload('x')]);
    raw.fill(0);
    expect(await codec.decode(encoded)).toEqual([jsonPayload('x')]);
  });
});
