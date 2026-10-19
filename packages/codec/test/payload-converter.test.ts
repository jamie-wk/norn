import { describe, expect, it } from 'vitest';
import { defaultPayloadConverter, PayloadConverterError, type Payload } from '@temporalio/common';
import { NornJsonPayloadConverter, payloadConverter, type TemporalNamespace } from '../src/payload-converter.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();
const roundTrip = <T>(value: T): T => payloadConverter.fromPayload(payloadConverter.toPayload(value));
const json = (p: Payload) => dec.decode(p.data!);
const encoding = (p: Payload) => dec.decode(p.metadata!.encoding!);
const jsonPayload = (text: string): Payload => ({ metadata: { encoding: enc.encode('json/plain') }, data: enc.encode(text) });

const hasTemporal = 'Temporal' in globalThis;

/** A minimal stand-in for the TC39 Temporal API, so the tagging logic is tested on runtimes without it. */
function fakeTemporal(): TemporalNamespace {
  const make = (name: string) => {
    const Cls = class {
      constructor(readonly iso: string) {}
      get [Symbol.toStringTag]() {
        return `Temporal.${name}`;
      }
      toString() {
        return this.iso;
      }
      toJSON() {
        return this.iso;
      }
      static from(v: string) {
        return new Cls(v);
      }
    };
    return Cls;
  };
  return {
    Instant: make('Instant'),
    PlainDate: make('PlainDate'),
    PlainDateTime: make('PlainDateTime'),
    ZonedDateTime: make('ZonedDateTime'),
    Duration: make('Duration'),
    PlainTime: make('PlainTime'),
  };
}

describe('payloadConverter', () => {
  it('round-trips plain JSON values with the json/plain encoding', () => {
    for (const value of ['hello', 42, 1.5, true, null, [1, 'a', null], { a: { b: [1, 2, { c: 'd' }] } }]) {
      const payload = payloadConverter.toPayload(value);
      expect(encoding(payload)).toBe('json/plain');
      expect(payloadConverter.fromPayload(payload)).toEqual(value);
    }
  });

  it('round-trips undefined via binary/null', () => {
    const payload = payloadConverter.toPayload(undefined);
    expect(encoding(payload)).toBe('binary/null');
    expect(payloadConverter.fromPayload(payload)).toBeUndefined();
  });

  it('round-trips Uint8Array via binary/plain', () => {
    const bytes = new Uint8Array([1, 2, 3, 255]);
    const payload = payloadConverter.toPayload(bytes);
    expect(encoding(payload)).toBe('binary/plain');
    expect(payloadConverter.fromPayload(payload)).toEqual(bytes);
  });

  it('round-trips bigint at the top level and nested', () => {
    expect(roundTrip(123n)).toBe(123n);
    expect(roundTrip(-(2n ** 100n))).toBe(-(2n ** 100n));
    const value = { total: 10n ** 30n, lines: [{ cents: 5n, qty: 2 }, 7n], name: 'x' };
    expect(roundTrip(value)).toEqual(value);
  });

  it('encodes bigint with the documented tag form', () => {
    expect(json(payloadConverter.toPayload({ n: 123n }))).toBe('{"n":{"$norn":"bigint","v":"123"}}');
  });

  it('leaves Date as an ISO string, like the default converter', () => {
    const date = new Date('2026-01-02T03:04:05.678Z');
    const payload = payloadConverter.toPayload({ at: date });
    expect(json(payload)).toBe(json(defaultPayloadConverter.toPayload({ at: date })));
    expect(payloadConverter.fromPayload(payload)).toEqual({ at: '2026-01-02T03:04:05.678Z' });
  });

  it('leaves objects with a $norn key and an unknown tag as they are', () => {
    const text = '{"$norn":"mystery","v":"1","nested":{"$norn":"other","v":2},"arr":[{"$norn":"bigint"}]}';
    expect(payloadConverter.fromPayload(jsonPayload(text))).toEqual(JSON.parse(text));
    expect(payloadConverter.fromPayload(jsonPayload('{"$norn":"bigint","v":"1","extra":true}'))).toEqual({
      $norn: 'bigint',
      v: '1',
      extra: true,
    });
  });

  it('round-trips user objects that look like tags', () => {
    const value = { a: { $norn: 'bigint', v: '5' }, b: [{ $norn: 'Temporal.Instant', v: 'x' }], c: { $norn: 'object', v: {} } };
    expect(roundTrip(value)).toEqual(value);
  });

  it('keeps __proto__ keys as data', () => {
    const value = JSON.parse('{"__proto__":{"n":1},"x":2}') as Record<string, unknown>;
    const back = payloadConverter.fromPayload<Record<string, unknown>>(
      payloadConverter.toPayload({ ...value, big: 1n, x: 2 }),
    );
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(Object.hasOwn(back, '__proto__')).toBe(true);
    expect(back.big).toBe(1n);
  });

  it('refuses values JSON cannot represent', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => payloadConverter.toPayload(circular)).toThrow();
  });

  describe('compatibility with Temporal defaultPayloadConverter', () => {
    const plain = [{ a: 1, b: ['x', null, true], c: { d: 1.25 } }, 'str', 0, [], { nested: { deep: { $notNorn: 1 } } }];

    it('produces identical payloads for plain JSON', () => {
      for (const value of plain) {
        const ours = payloadConverter.toPayload(value);
        const theirs = defaultPayloadConverter.toPayload(value);
        expect(ours.metadata).toEqual(theirs.metadata);
        expect(ours.data).toEqual(theirs.data);
      }
    });

    it('decodes default-converter payloads, and the default converter decodes ours', () => {
      for (const value of plain) {
        expect(payloadConverter.fromPayload(defaultPayloadConverter.toPayload(value))).toEqual(value);
        expect(defaultPayloadConverter.fromPayload(payloadConverter.toPayload(value))).toEqual(value);
      }
    });
  });
});

describe('NornJsonPayloadConverter with Temporal API types', () => {
  const types = ['Instant', 'PlainDate', 'PlainDateTime', 'ZonedDateTime', 'Duration', 'PlainTime'] as const;

  it('tags and revives every supported type (injected implementation)', () => {
    const temporal = fakeTemporal();
    const converter = new NornJsonPayloadConverter({ temporal });
    const values = Object.fromEntries(types.map((t) => [t, (temporal[t] as { from(v: string): unknown }).from(`iso-${t}`)]));
    const payload = converter.toPayload({ values, list: [values.Instant] })!;
    expect(JSON.parse(json(payload)).values.Instant).toEqual({ $norn: 'Temporal.Instant', v: 'iso-Instant' });
    const back = converter.fromPayload<{ values: Record<string, unknown>; list: unknown[] }>(payload);
    for (const t of types) {
      expect(back.values[t]).toBeInstanceOf(temporal[t] as never);
      expect(String(back.values[t])).toBe(`iso-${t}`);
    }
    expect(back.list[0]).toBeInstanceOf(temporal.Instant as never);
  });

  it('reports a clear error when a tagged Temporal value arrives on a runtime without Temporal', () => {
    const converter = new NornJsonPayloadConverter({ temporal: null });
    const payload = jsonPayload('{"at":{"$norn":"Temporal.Instant","v":"2026-01-01T00:00:00Z"}}');
    expect(() => converter.fromPayload(payload)).toThrow(PayloadConverterError);
    expect(() => converter.fromPayload(payload)).toThrow(/Temporal\.Instant.*globalThis\.Temporal/);
  });

  it.skipIf(hasTemporal)('the default converter reports the missing global on this runtime', () => {
    const payload = jsonPayload('{"$norn":"Temporal.PlainDate","v":"2026-01-01"}');
    expect(() => payloadConverter.fromPayload(payload)).toThrow(/globalThis\.Temporal/);
  });

  it.skipIf(!hasTemporal)('round-trips native Temporal values', () => {
    const T = (globalThis as unknown as { Temporal: any }).Temporal;
    const value = {
      instant: T.Instant.from('2026-01-02T03:04:05.123456789Z'),
      date: T.PlainDate.from('2026-01-02'),
      dateTime: T.PlainDateTime.from('2026-01-02T03:04:05'),
      zoned: T.ZonedDateTime.from('2026-01-02T03:04:05+01:00[Europe/Paris]'),
      duration: T.Duration.from('P1DT2H'),
      time: T.PlainTime.from('03:04:05'),
    };
    const back = roundTrip(value) as typeof value;
    for (const key of Object.keys(value) as (keyof typeof value)[]) {
      expect(back[key]).toBeInstanceOf(value[key].constructor);
      expect(back[key].toString()).toBe(value[key].toString());
    }
  });
});
