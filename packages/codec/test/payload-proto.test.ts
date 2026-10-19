import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Payload } from '@temporalio/common';
import { decodePayload, encodePayload } from '../src/payload-proto.ts';

// @temporalio/proto is only a dependency of @temporalio/common, so resolve it from there.
const requireFromCommon = createRequire(createRequire(import.meta.url).resolve('@temporalio/common'));
interface PayloadType {
  encode(p: Payload): { finish(): Uint8Array };
  decode(b: Uint8Array): Payload;
  toObject(m: Payload, o: Record<string, unknown>): Record<string, unknown>;
}
const { temporal } = requireFromCommon('@temporalio/proto') as {
  temporal: { api: { common: { v1: { Payload: PayloadType } } } };
};
const ProtoPayload = temporal.api.common.v1.Payload;

const enc = new TextEncoder();

const samples: Payload[] = [
  { metadata: { encoding: enc.encode('json/plain') }, data: enc.encode('{"a":1}') },
  { metadata: { encoding: enc.encode('binary/null') } },
  { metadata: {}, data: new Uint8Array(0) },
  { metadata: { encoding: enc.encode('binary/plain'), 'ünïcødé-key': new Uint8Array([0, 1, 2]), empty: new Uint8Array(0) }, data: new Uint8Array(300).fill(7) },
  { data: Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256) },
  { metadata: { encoding: enc.encode('json/external') }, externalPayloads: [{ sizeBytes: 123_456_789 as never }, { sizeBytes: 0 as never }, {}] },
  { metadata: { '': new Uint8Array([1]) }, externalPayloads: [{ sizeBytes: -1 as never }] },
];

const normalize = (p: Payload) => ProtoPayload.toObject(ProtoPayload.decode(ProtoPayload.encode(p).finish()), { longs: Number, bytes: Array, defaults: false });

describe('Payload protobuf wire format', () => {
  it('encodes byte-for-byte like @temporalio/proto', () => {
    for (const p of samples) {
      expect(Buffer.from(encodePayload(p)).toString('hex')).toBe(Buffer.from(ProtoPayload.encode(p).finish()).toString('hex'));
    }
  });

  it('decodes what @temporalio/proto encodes', () => {
    for (const p of samples) {
      const ours = decodePayload(ProtoPayload.encode(p).finish());
      expect(normalize(ours)).toEqual(normalize(p));
    }
  });

  it('round-trips', () => {
    for (const p of samples) expect(normalize(decodePayload(encodePayload(p)))).toEqual(normalize(p));
  });

  it('skips unknown fields', () => {
    // field 15, varint 1; field 14, length-delimited "hi"; then data = [9]
    const bytes = new Uint8Array([0x78, 0x01, 0x72, 0x02, 0x68, 0x69, 0x12, 0x01, 0x09]);
    expect(decodePayload(bytes).data).toEqual(new Uint8Array([9]));
  });

  it('rejects truncated input', () => {
    const bytes = encodePayload(samples[0]!);
    expect(() => decodePayload(bytes.subarray(0, bytes.length - 2))).toThrow();
  });
});
