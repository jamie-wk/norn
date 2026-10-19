# @norn/codec

Payload encryption with key rotation, and a payload converter that round-trips `bigint` and TC39 Temporal API values, for [Norn](https://jamie-wk.github.io/norn/) and plain Temporal TypeScript apps.

- **`createEncryptionCodec`**: a Temporal `PayloadCodec` using AES-256-GCM (WebCrypto only), with key ids in payload metadata so you can rotate keys without breaking existing history.
- **`payloadConverter`**: Temporal's default converter (`binary/null`, `binary/plain`, `json/plain`), plus lossless `bigint` and `Temporal.Instant` / `PlainDate` / `PlainDateTime` / `ZonedDateTime` / `Duration` / `PlainTime`. For plain JSON it writes the same bytes as Temporal's default converter, and it reads anything the default converter wrote.
- **`createDataConverter` / `clientDataConverter`**: both together, wired up for workers and clients.

The only runtime dependency is the peer `@temporalio/common`.

## Install

```sh
pnpm add @norn/codec
```

Requires Node 22.18+ (or any runtime with WebCrypto for the codec on its own).

### Entry points

| Import | Contents | Runtimes |
| --- | --- | --- |
| `@norn/codec` | Everything below, plus `createDataConverter`, `clientDataConverter`, `resolvePayloadConverterPath` and `NornCodecError` | Node (imports `node:url` for `resolvePayloadConverterPath()`) |
| `@norn/codec/encryption` | `createEncryptionCodec`, `generateKey`, `EncryptionCodecOptions`, `ENCRYPTED_ENCODING`, `ENCRYPTION_KEY_ID_METADATA_KEY` | Any runtime with WebCrypto: Node, Bun, Deno, Cloudflare Workers, Vercel Edge (type-only imports from `@temporalio/common`, nothing at runtime) |
| `@norn/codec/payload-converter` | `payloadConverter`, `NornJsonPayloadConverter`, `TEMPORAL_TYPES` | Anywhere `@temporalio/common` runs, including the workflow sandbox; this is the module `payloadConverterPath` points workers at |

Use `@norn/codec/encryption` for codec servers on edge runtimes, so the bundle never pulls in `node:url` (no `nodejs_compat` flag needed on Cloudflare Workers):

```ts
import { createEncryptionCodec } from '@norn/codec/encryption';
```

The codec still throws `NornCodecError` for bad keys and tampered payloads; check `error.name === 'NornCodecError'` if you need to tell them apart without importing the main entry.

## Usage

Generate a key once and store it in your secret manager:

```sh
node -e "import('@norn/codec').then(m => console.log(m.generateKey()))"
```

### Worker

```ts
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { createDataConverter } from '@norn/codec';

const keys = { '2026-10': process.env.NORN_KEY_2026_10! };

const worker = await Worker.create({
  connection,
  taskQueue: 'orders',
  workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)),
  dataConverter: createDataConverter({ keys, currentKeyId: '2026-10' }),
});
```

`createDataConverter` returns `{ payloadConverterPath, payloadCodecs }`. The path makes the worker load the converter inside the workflow sandbox too, so workflows can receive and return `bigint`s. If you prebuild bundles with `bundleWorkflowCode`, pass it the same path:

```ts
import { resolvePayloadConverterPath } from '@norn/codec';
await bundleWorkflowCode({ workflowsPath, payloadConverterPath: resolvePayloadConverterPath() });
```

### Client

```ts
import { Client } from '@temporalio/client';
import { clientDataConverter } from '@norn/codec';

const client = new Client({ connection, dataConverter: clientDataConverter({ keys, currentKeyId: '2026-10' }) });
const total: bigint = await client.workflow.execute('sumInvoices', { taskQueue: 'orders', workflowId, args: [[1n, 2n]] });
```

`clientDataConverter` passes the converter object rather than a path, so it also works in bundled and edge deployments.

Use `createEncryptionCodec` directly if you only want encryption (with Temporal's default converter), and `createDataConverter()` without keys if you only want the converter. A `codec` option (for example compression) runs before encryption.

### Codec server (Temporal UI / CLI)

The Temporal UI and `temporal` CLI can decode payloads through a [codec server](https://docs.temporal.io/production-deployment/data-encryption). A sketch with Hono:

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Payload } from '@temporalio/common';
import { createEncryptionCodec } from '@norn/codec';

const codec = createEncryptionCodec({ keys, currentKeyId: '2026-10' });

type JsonPayload = { metadata?: Record<string, string>; data?: string };
const b64 = {
  from: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  to: (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join('')),
};
const fromJson = (p: JsonPayload): Payload => ({
  metadata: Object.fromEntries(Object.entries(p.metadata ?? {}).map(([k, v]) => [k, b64.from(v)])),
  data: b64.from(p.data ?? ''),
});
const toJson = (p: Payload): JsonPayload => ({
  metadata: Object.fromEntries(Object.entries(p.metadata ?? {}).map(([k, v]) => [k, b64.to(v)])),
  data: b64.to(p.data ?? new Uint8Array()),
});

const app = new Hono();
app.use('*', cors({ origin: 'https://cloud.temporal.io', allowHeaders: ['Content-Type', 'X-Namespace', 'Authorization'], credentials: true }));
for (const op of ['encode', 'decode'] as const) {
  app.post(`/${op}`, async (c) => {
    // Authenticate the caller here: anyone who can call /decode can read your payloads.
    const { payloads } = await c.req.json<{ payloads: JsonPayload[] }>();
    return c.json({ payloads: (await codec[op](payloads.map(fromJson))).map(toJson) });
  });
}
export default app;
```

## Key rotation

1. Generate a new key and add it to `keys` everywhere (workers, clients, codec server), keeping `currentKeyId` unchanged. Deploy.
2. Once every process has the new key, set `currentKeyId` to it. Deploy. New payloads use the new key; old ones still decrypt with the key named in their metadata.
3. Keep the old key in `keys` until no retained history, schedule, or long-running workflow references it (that is, until the namespace's retention period has passed for all workflows that started before step 2, and running workflows have continued-as-new or finished). Then remove it.

Doing step 1 everywhere before step 2 matters: a process that receives a payload encrypted with a key it doesn't have fails with `NornCodecError` ("encrypted with key ..., which is not configured").

Enabling encryption on an existing namespace is safe: `decode` passes payloads that aren't `binary/encrypted` through untouched.

## Format

An encrypted payload has metadata `encoding: binary/encrypted` and `encryption-key-id: <id>` (UTF-8), and data `IV (12 random bytes) || AES-256-GCM ciphertext || tag (16 bytes)`. The plaintext is the original `temporal.api.common.v1.Payload` serialized as protobuf (so its metadata, including its original encoding, is encrypted too), and the additional authenticated data is the UTF-8 key id. This is easy to reimplement in another SDK's codec.

Tagged JSON values look like `{"$norn":"bigint","v":"123"}` and `{"$norn":"Temporal.Instant","v":"2026-10-19T00:00:00Z"}`. A tag only matches an object with exactly the keys `$norn` and `v`; your own objects with a `$norn` key are escaped when written and unknown tags are left alone when read. `Date` is not special-cased (it becomes an ISO string, as with the default converter). Temporal API values are revived with `globalThis.Temporal.X.from(v)`; on runtimes without `Temporal` (Node 22, and the workflow sandbox there), decoding one throws a `PayloadConverterError` saying so.

## Security notes

- Keys must be exactly 32 random bytes (base64 or `Uint8Array`); `createEncryptionCodec` rejects anything else at startup. Error messages name key ids but never include key material. Key ids are stored in plaintext, so don't put secrets in them.
- Keys are imported as non-extractable WebCrypto keys and the raw bytes are wiped once imported.
- Each payload gets a fresh random IV. With random 96-bit IVs, NIST recommends at most about 2³² encryptions per key: rotate well before that.
- GCM authenticates the data and key id, so tampering is detected (`NornCodecError: ... could not be decrypted ...`). It does not stop a payload from being replayed into a different place in history, and metadata outside the encrypted envelope (like the key id) is visible to the server.
- Encryption covers payloads (inputs, results, signals, queries, updates, memos, heartbeat details, failure details encoded as payloads). It does not cover workflow ids, types, task queues, search attributes, or failure messages and stack traces, unless you also configure a failure converter with `encodeCommonAttributes`.
- Decoding passes payloads that aren't `binary/encrypted` through unchanged, as Temporal's own codecs do, so a namespace with existing plaintext history keeps working after you turn encryption on. The flip side: a client deployed without the codec writes plaintext that workers accept silently, so configure the codec on every client and worker.
- A codec server can decrypt everything it is given: put it behind authentication and restrict CORS to your Temporal UI origin.
