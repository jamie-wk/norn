---
title: "@norn-ts/codec"
description: "AES-256-GCM payload encryption with key rotation, and a payload converter for bigint and Temporal API values."
sidebar:
  order: 9
---

Payload encryption with key rotation, and a payload converter that round-trips `bigint` and TC39 Temporal API values. It works with Norn and with plain Temporal TypeScript apps. For a walkthrough, see [Encryption](/norn/guides/encryption/).

- **`createEncryptionCodec`**: a Temporal `PayloadCodec` using AES-256-GCM (WebCrypto only). Key ids go in payload metadata, so you can rotate keys without breaking existing history.
- **`payloadConverter`**: Temporal's default converter (`binary/null`, `binary/plain`, `json/plain`), plus lossless `bigint` and `Temporal.Instant` / `PlainDate` / `PlainDateTime` / `ZonedDateTime` / `Duration` / `PlainTime`. For plain JSON it writes the same bytes as Temporal's default converter, and it reads anything the default converter wrote.
- **`createDataConverter` / `clientDataConverter`**: both together, wired up for workers and clients.

The only runtime dependency is the peer `@temporalio/common`.

## Install

```sh
pnpm add @norn-ts/codec
```

Requires Node 22.18+ (or any runtime with WebCrypto for the codec on its own).

## Entry points

| Import | Contents | Runtimes |
| --- | --- | --- |
| `@norn-ts/codec` | Everything below, plus `createDataConverter`, `clientDataConverter`, `resolvePayloadConverterPath`, `NornDataConverterOptions`, `WorkerDataConverter` and `NornCodecError` | Node (imports `node:url` for `resolvePayloadConverterPath()`) |
| `@norn-ts/codec/encryption` | `createEncryptionCodec`, `generateKey`, `EncryptionCodecOptions`, `ENCRYPTED_ENCODING`, `ENCRYPTION_KEY_ID_METADATA_KEY` | Any runtime with WebCrypto: Node, Bun, Deno, Cloudflare Workers, Vercel Edge (type-only imports from `@temporalio/common`, nothing at runtime) |
| `@norn-ts/codec/payload-converter` | `payloadConverter`, `NornJsonPayloadConverter`, `NornJsonPayloadConverterOptions`, `TEMPORAL_TYPES`, `TemporalTypeName`, `TemporalNamespace` | Anywhere `@temporalio/common` runs, including the workflow sandbox. This is the module `payloadConverterPath` points workers at. |

Use `@norn-ts/codec/encryption` for codec servers on edge runtimes, so the bundle never pulls in `node:url` (no `nodejs_compat` flag needed on Cloudflare Workers):

```ts
import { createEncryptionCodec } from '@norn-ts/codec/encryption';
```

The codec still throws `NornCodecError` for bad keys and tampered payloads. Check `error.name === 'NornCodecError'` if you need to tell them apart without importing the main entry.

## Keys

### `generateKey()`

Returns a new random 32-byte AES-256 key, base64-encoded. Generate a key once and store it in your secret manager, never in source control:

```sh
node -e "import('@norn-ts/codec').then(m => console.log(m.generateKey()))"
```

### `createEncryptionCodec(options)`

Returns a Temporal `PayloadCodec` that encrypts every payload with AES-256-GCM.

```ts
const codec = createEncryptionCodec({
  keys: { '2026-10': process.env.NORN_KEY_2026_10!, '2026-04': process.env.NORN_KEY_2026_04! },
  currentKeyId: '2026-10',
});
```

| Option | Type | Description |
| --- | --- | --- |
| `keys` | `Record<string, string \| Uint8Array>` | Every key that may be needed to decrypt existing payloads, by key id. Values are base64 strings (standard or URL-safe alphabet) or raw bytes, exactly 32 bytes each. Key ids must be non-empty, and are stored in plaintext, so they must not be secret. |
| `currentKeyId` | `string` | The key used to encrypt new payloads. Must be one of `keys`. |

It throws `NornCodecError` at creation when `keys` is missing, a key id is empty, a key is not valid base64 or not 32 bytes, or `currentKeyId` is not in `keys`. `decode` rejects with `NornCodecError` for a payload with no key id, an unknown key id, tampered or corrupted data, or data that decrypts to an invalid payload.

`decode` passes payloads that aren't `binary/encrypted` through untouched, so enabling encryption on an existing namespace is safe.

The constants `ENCRYPTED_ENCODING` (`'binary/encrypted'`) and `ENCRYPTION_KEY_ID_METADATA_KEY` (`'encryption-key-id'`) are the metadata values the codec writes.

## Data converters

Both functions take the same options:

| Option | Type | Description |
| --- | --- | --- |
| `keys` | `EncryptionCodecOptions['keys']` | Encryption keys by id. Requires `currentKeyId`. |
| `currentKeyId` | `string` | Key id used to encrypt new payloads. Requires `keys`. |
| `codec` | `PayloadCodec` | A codec, such as compression, that runs before encryption on encode and after it on decode. |

Passing only one of `keys` and `currentKeyId` throws `NornCodecError`. Without either, you get the payload converter with no encryption. Use `createEncryptionCodec` directly if you only want encryption with Temporal's default converter.

### Worker: `createDataConverter(options?)`

```ts
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { createDataConverter } from '@norn-ts/codec';

const keys = { '2026-10': process.env.NORN_KEY_2026_10! };

const worker = await Worker.create({
  connection,
  taskQueue: 'orders',
  workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)),
  dataConverter: createDataConverter({ keys, currentKeyId: '2026-10' }),
});
```

It returns `WorkerDataConverter`, `{ payloadConverterPath, payloadCodecs }`. The path makes the worker load the converter inside the workflow sandbox too, so workflows can receive and return `bigint`s.

If you prebuild bundles with `bundleWorkflowCode`, pass it the same path. `resolvePayloadConverterPath()` returns the absolute path of the `payload-converter` module (the `.ts` source when running from source, the `.js` build otherwise):

```ts
import { resolvePayloadConverterPath } from '@norn-ts/codec';

await bundleWorkflowCode({ workflowsPath, payloadConverterPath: resolvePayloadConverterPath() });
```

With `@norn-ts/worker`, pass the result as `createWorker({ dataConverter })`, and pass `resolvePayloadConverterPath()` as `bundleWorkflows({ payloadConverterPath })` (or run `norn bundle --codec`); see [`@norn-ts/worker`](/norn/reference/worker/).

### Client: `clientDataConverter(options?)`

```ts
import { Client } from '@temporalio/client';
import { clientDataConverter } from '@norn-ts/codec';

const client = new Client({ connection, dataConverter: clientDataConverter({ keys, currentKeyId: '2026-10' }) });
const total: bigint = await client.workflow.execute('sumInvoices', { taskQueue: 'orders', workflowId, args: [[1n, 2n]] });
```

It returns a loaded data converter (`payloadConverter`, Temporal's default failure converter and the codecs). It passes the converter object rather than a path, so it also works in bundled and edge deployments.

### Codec server (Temporal UI / CLI)

The Temporal UI and `temporal` CLI can decode payloads through a [codec server](https://docs.temporal.io/production-deployment/data-encryption). Use `codecServer()` from [`@norn-ts/hono`](/norn/reference/hono/), which adds authentication, CORS, namespace checks and body limits:

```ts
app.route('/codec', codecServer({
  codec: createEncryptionCodec({ keys, currentKeyId: '2026-10' }),
  auth: (c) => c.req.header('authorization') === `Bearer ${env.CODEC_TOKEN}`,
}));
```

## Payload converter

`payloadConverter` is a `CompositePayloadConverter`: `undefined` becomes `binary/null`, `Uint8Array` becomes `binary/plain`, and everything else goes through `NornJsonPayloadConverter` as `json/plain`. Temporal requires the export name `payloadConverter` for modules loaded through `payloadConverterPath`.

`new NornJsonPayloadConverter(options?)` is the JSON part on its own:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `temporal` | `TemporalNamespace \| null` | `globalThis.Temporal`, looked up on every call | The Temporal API used to revive Temporal values. Pass a polyfill's namespace to use it without installing it globally, or `null` to disable reviving Temporal values. |

`TEMPORAL_TYPES` lists the Temporal types it round-trips: `['Instant', 'PlainDate', 'PlainDateTime', 'ZonedDateTime', 'Duration', 'PlainTime']`.

## Key rotation

1. Generate a new key and add it to `keys` everywhere (workers, clients, codec server), keeping `currentKeyId` unchanged. Deploy.
2. Once every process has the new key, set `currentKeyId` to it. Deploy. New payloads use the new key; old ones still decrypt with the key named in their metadata.
3. Keep the old key in `keys` until no retained history, schedule or long-running workflow references it. That is, until the namespace's retention period has passed for all workflows that started before step 2, and running workflows have continued-as-new or finished. Then remove it.

Doing step 1 everywhere before step 2 matters: a process that receives a payload encrypted with a key it doesn't have fails with `NornCodecError` ("encrypted with key ..., which is not configured").

## Format

An encrypted payload has metadata `encoding: binary/encrypted` and `encryption-key-id: <id>` (UTF-8), and data `IV (12 random bytes) || AES-256-GCM ciphertext || tag (16 bytes)`. The plaintext is the original `temporal.api.common.v1.Payload` serialized as protobuf, so its metadata, including its original encoding, is encrypted too. The additional authenticated data is the UTF-8 key id. This is easy to reimplement in another SDK's codec.

Tagged JSON values look like `{"$norn":"bigint","v":"123"}` and `{"$norn":"Temporal.Instant","v":"2026-10-19T00:00:00Z"}`. A tag only matches an object with exactly the keys `$norn` and `v`. Your own objects with a `$norn` key are escaped when written (`{"$norn":"object","v":{...}}`), and unknown tags are left alone when read. Temporal values are recognized by `Symbol.toStringTag`, so polyfill instances work too. `Date` is not special-cased: it becomes an ISO string, as with the default converter.

Temporal API values are revived with `Temporal.X.from(v)`. On runtimes without `Temporal` (Node 22, and the workflow sandbox there), decoding one throws a `PayloadConverterError` saying so, unless you pass an implementation through the `temporal` option.

## Security notes

- Keys must be exactly 32 random bytes (base64 or `Uint8Array`); `createEncryptionCodec` rejects anything else at startup. Error messages name key ids but never include key material. Key ids are stored in plaintext, so don't put secrets in them.
- Keys are imported as non-extractable WebCrypto keys on first use, and the raw bytes are wiped once imported.
- Each payload gets a fresh random IV. With random 96-bit IVs, NIST recommends at most about 2³² encryptions per key: rotate well before that.
- GCM authenticates the data and key id, so tampering is detected (`NornCodecError: ... could not be decrypted ...`). It does not stop a payload from being replayed into a different place in history, and metadata outside the encrypted envelope (like the key id) is visible to the server.
- Encryption covers payloads (inputs, results, signals, queries, updates, memos, heartbeat details, failure details encoded as payloads). It does not cover workflow ids, types, task queues, search attributes, or failure messages and stack traces, unless you also configure a failure converter with `encodeCommonAttributes`.
- Decoding passes payloads that aren't `binary/encrypted` through unchanged, as Temporal's own codecs do, so a namespace with existing plaintext history keeps working after you turn encryption on. The flip side: a client deployed without the codec writes plaintext that workers accept silently, so configure the codec on every client and worker.
- A codec server can decrypt everything it is given: put it behind authentication and restrict CORS to your Temporal UI origin.

## Exports

| Export | Kind |
| --- | --- |
| `createEncryptionCodec(options)`, `generateKey()`, `EncryptionCodecOptions` | Encryption |
| `ENCRYPTED_ENCODING`, `ENCRYPTION_KEY_ID_METADATA_KEY` | Metadata constants |
| `createDataConverter(options?)`, `clientDataConverter(options?)`, `NornDataConverterOptions`, `WorkerDataConverter` | Data converters |
| `resolvePayloadConverterPath()` | Path for `bundleWorkflowCode({ payloadConverterPath })` |
| `payloadConverter`, `NornJsonPayloadConverter`, `NornJsonPayloadConverterOptions`, `TEMPORAL_TYPES`, `TemporalTypeName`, `TemporalNamespace` | Payload converter |
| `NornCodecError` | Error class (a plain `Error` subclass; this package does not depend on `@norn-ts/core`) |
