import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultFailureConverter, type Payload } from '@temporalio/common';
import { clientDataConverter, createDataConverter, createEncryptionCodec, generateKey, NornCodecError } from '../src/index.ts';
import { payloadConverter } from '../src/payload-converter.ts';

const keys = { k1: generateKey() };
const dec = new TextDecoder();

describe('createDataConverter', () => {
  it('points payloadConverterPath at the sibling payload-converter module', () => {
    const { payloadConverterPath } = createDataConverter();
    expect(isAbsolute(payloadConverterPath)).toBe(true);
    expect(payloadConverterPath).toMatch(/[/\\]src[/\\]payload-converter\.ts$/);
    expect(existsSync(payloadConverterPath)).toBe(true);
  });

  it('has no codecs unless keys or a codec are given', () => {
    expect(createDataConverter().payloadCodecs).toEqual([]);
  });

  it('adds an encryption codec when keys are given', async () => {
    const { payloadCodecs } = createDataConverter({ keys, currentKeyId: 'k1' });
    expect(payloadCodecs).toHaveLength(1);
    const [encoded] = await payloadCodecs[0]!.encode([payloadConverter.toPayload(1n)]);
    expect(dec.decode(encoded!.metadata!.encoding!)).toBe('binary/encrypted');
  });

  it('runs a custom codec before encryption', () => {
    const custom = { encode: async (p: Payload[]) => p, decode: async (p: Payload[]) => p };
    const { payloadCodecs } = createDataConverter({ codec: custom, keys, currentKeyId: 'k1' });
    expect(payloadCodecs[0]).toBe(custom);
    expect(payloadCodecs).toHaveLength(2);
  });

  it('requires currentKeyId together with keys', () => {
    expect(() => createDataConverter({ keys })).toThrow(NornCodecError);
    expect(() => createDataConverter({ currentKeyId: 'k1' })).toThrow(NornCodecError);
  });
});

describe('clientDataConverter', () => {
  it('returns a loaded converter that round-trips through the codec', async () => {
    const dc = clientDataConverter({ keys, currentKeyId: 'k1' });
    expect(dc.payloadConverter).toBe(payloadConverter);
    expect(dc.failureConverter).toBe(defaultFailureConverter);
    const encoded = await dc.payloadCodecs[0]!.encode([dc.payloadConverter.toPayload({ n: 5n })]);
    const decoded = await dc.payloadCodecs[0]!.decode(encoded);
    expect(dc.payloadConverter.fromPayload(decoded[0]!)).toEqual({ n: 5n });
  });

  it('accepts a prebuilt codec', () => {
    const codec = createEncryptionCodec({ keys, currentKeyId: 'k1' });
    expect(clientDataConverter({ codec }).payloadCodecs).toEqual([codec]);
  });
});
