/**
 * A minimal, dependency-free protobuf codec for `temporal.api.common.v1.Payload`.
 *
 * `@temporalio/proto` is only a transitive dependency (of `@temporalio/common`), so it cannot be
 * imported reliably from here under strict package managers, and pulling protobufjs into codec
 * servers running on edge runtimes is heavy. The Payload message is tiny, so it is encoded by hand:
 *
 * ```proto
 * message Payload {
 *   map<string, bytes> metadata = 1;
 *   bytes data = 2;
 *   repeated ExternalPayloadDetails external_payloads = 3;
 *   message ExternalPayloadDetails { int64 size_bytes = 1; }
 * }
 * ```
 *
 * The output is byte-for-byte identical to `Payload.encode(payload).finish()` from
 * `@temporalio/proto` (same field and map-entry order), so encrypted payloads are interchangeable
 * with codecs built on the official protobuf classes. Decoding accepts any valid encoding and
 * skips unknown fields.
 *
 * @internal
 */
import type { Payload } from '@temporalio/common';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const EMPTY = new Uint8Array(0);

class Writer {
  private buf = new Uint8Array(256);
  private len = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  varint(value: number): this {
    this.ensure(10);
    while (value > 0x7f) {
      this.buf[this.len++] = (value % 0x80) | 0x80;
      value = Math.floor(value / 0x80);
    }
    this.buf[this.len++] = value;
    return this;
  }

  varint64(value: bigint): this {
    this.ensure(10);
    let v = BigInt.asUintN(64, value);
    while (v > 0x7fn) {
      this.buf[this.len++] = Number(v & 0x7fn) | 0x80;
      v >>= 7n;
    }
    this.buf[this.len++] = Number(v);
    return this;
  }

  bytes(value: Uint8Array): this {
    this.varint(value.length);
    this.ensure(value.length);
    this.buf.set(value, this.len);
    this.len += value.length;
    return this;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Accepts the shapes protobufjs accepts for int64: number, bigint, numeric string or Long. */
function toBigInt64(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') return BigInt(value);
  if (value && typeof value === 'object' && 'low' in value && 'high' in value) {
    const { low, high } = value as { low: number; high: number };
    return (BigInt(high) << 32n) | BigInt(low >>> 0);
  }
  throw new TypeError('Unsupported int64 value');
}

function sub(write: (w: Writer) => void): Uint8Array {
  const w = new Writer();
  write(w);
  return w.finish();
}

/** Serializes a Payload exactly like `temporal.api.common.v1.Payload.encode(payload).finish()`. */
export function encodePayload(payload: Payload): Uint8Array {
  const w = new Writer();
  if (payload.metadata != null) {
    for (const key of Object.keys(payload.metadata)) {
      const value = payload.metadata[key] ?? EMPTY;
      w.varint(0x0a).bytes(sub((e) => e.varint(0x0a).bytes(utf8Encoder.encode(key)).varint(0x12).bytes(value)));
    }
  }
  // proto3 implicit presence: default (empty / zero) singular fields are omitted, as protobufjs does.
  if (payload.data != null && payload.data.length > 0) w.varint(0x12).bytes(payload.data);
  if (payload.externalPayloads != null) {
    for (const details of payload.externalPayloads) {
      w.varint(0x1a).bytes(
        sub((e) => {
          const size = details.sizeBytes == null ? 0n : toBigInt64(details.sizeBytes);
          if (size !== 0n) e.varint(0x08).varint64(size);
        }),
      );
    }
  }
  return w.finish();
}

class Reader {
  pos = 0;
  private readonly buf: Uint8Array;
  private readonly end: number;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.end = buf.length;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint64(): bigint {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (this.pos >= this.end) throw new RangeError('Truncated varint');
      const byte = this.buf[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return BigInt.asUintN(64, result);
    }
    throw new RangeError('Malformed varint');
  }

  varint(): number {
    const value = this.varint64();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Varint too large');
    return Number(value);
  }

  bytes(): Uint8Array {
    const len = this.varint();
    if (this.pos + len > this.end) throw new RangeError('Truncated length-delimited field');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint64();
    else if (wireType === 1) this.advance(8);
    else if (wireType === 2) this.bytes();
    else if (wireType === 5) this.advance(4);
    else throw new RangeError(`Unsupported wire type ${wireType}`);
  }

  private advance(n: number): void {
    if (this.pos + n > this.end) throw new RangeError('Truncated fixed-width field');
    this.pos += n;
  }
}

function decodeMapEntry(bytes: Uint8Array): [string, Uint8Array] {
  const r = new Reader(bytes);
  let key = '';
  let value: Uint8Array = EMPTY;
  while (!r.done) {
    const tag = r.varint();
    if (tag === 0x0a) key = utf8Decoder.decode(r.bytes());
    else if (tag === 0x12) value = r.bytes();
    else r.skip(tag & 7);
  }
  return [key, value];
}

function decodeExternalDetails(bytes: Uint8Array): { sizeBytes?: number } {
  const r = new Reader(bytes);
  const out: { sizeBytes?: number } = {};
  while (!r.done) {
    const tag = r.varint();
    if (tag === 0x08) out.sizeBytes = Number(BigInt.asIntN(64, r.varint64()));
    else r.skip(tag & 7);
  }
  return out;
}

/**
 * Parses a serialized Payload. Byte fields are views into `bytes`. `externalPayloads[].sizeBytes`
 * is returned as a number (the SDK accepts numbers and Longs alike).
 *
 * @throws RangeError / TypeError on malformed input.
 */
export function decodePayload(bytes: Uint8Array): Payload {
  const r = new Reader(bytes);
  const metadata: Record<string, Uint8Array> = {};
  const payload: Payload = { metadata };
  while (!r.done) {
    const tag = r.varint();
    if (tag === 0x0a) {
      const [key, value] = decodeMapEntry(r.bytes());
      // defineProperty, so a "__proto__" key stays data instead of replacing the prototype.
      Object.defineProperty(metadata, key, { value, enumerable: true, writable: true, configurable: true });
    } else if (tag === 0x12) {
      payload.data = r.bytes();
    } else if (tag === 0x1a) {
      (payload.externalPayloads ??= []).push(decodeExternalDetails(r.bytes()) as never);
    } else {
      r.skip(tag & 7);
    }
  }
  return payload;
}
