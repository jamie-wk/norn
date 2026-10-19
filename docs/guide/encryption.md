# Encryption & codec server

Temporal stores every workflow input, result, signal, update, query result and activity argument in its database. If those contain personal data, bank details or contract terms, encrypt them **before they leave your process**: the server, its database, backups and anyone with access to the Temporal UI then see only ciphertext.

`@norn/codec` provides:

- **`createEncryptionCodec()`**: a Temporal `PayloadCodec` using AES-256-GCM via WebCrypto, with the key ID stored in each payload so you can rotate keys without breaking existing history.
- **`payloadConverter`**: Temporal's default converter plus lossless `bigint` and TC39 `Temporal.*` values (`Instant`, `PlainDate`, `ZonedDateTime`, ...). It writes the same bytes as the default converter for plain JSON, so switching is safe.
- **`createDataConverter()`** for workers and **`clientDataConverter()`** for clients: both together.

## Set up

Generate a key once and put it in your secret manager:

```sh
node -e "import('@norn/codec').then(m => console.log(m.generateKey()))"
```

Keys are 32 random bytes, base64-encoded; anything else is rejected at startup. Load them from the environment in both the worker and every client:

```ts
// src/codec.ts
// {"2026-10":"<base64>"}
export const keys = JSON.parse(process.env.NORN_ENCRYPTION_KEYS ?? '{}') as Record<string, string>;
export const currentKeyId = process.env.NORN_ENCRYPTION_KEY_ID ?? '2026-10';
```

### Worker

```ts
import { createDataConverter } from '@norn/codec';
import { createWorker } from '@norn/worker';
import { registry } from '../.norn/registry.js';
import { currentKeyId, keys } from './codec.js';

const worker = await createWorker({ registry, dataConverter: createDataConverter({ keys, currentKeyId }) });
await worker.run();
```

`createDataConverter()` returns `{ payloadConverterPath, payloadCodecs }`. The path makes the worker load the converter inside the workflow sandbox too, so workflows can receive and return `bigint`s. When `createWorker()` bundles at startup it passes the path to the bundler for you. If you **prebuild the bundle**, pass it yourself:

```ts
import { resolvePayloadConverterPath } from '@norn/codec';
await bundleWorkflows(registry, { outFile: 'dist/workflow-bundle.js', payloadConverterPath: resolvePayloadConverterPath() });
```

### Client

```ts
import { clientDataConverter } from '@norn/codec';
import { createClient } from '@norn/client';

const norn = createClient({ dataConverter: clientDataConverter({ keys, currentKeyId }) });
```

`clientDataConverter()` passes the converter object rather than a module path, so it also works in bundled and edge deployments. The same goes for the [Hono middleware](/guide/hono): `temporal({ dataConverter: clientDataConverter({ keys, currentKeyId }) })`.

### Tests

```ts
await using env = await createTestEnv({
  registry,
  dataConverter: createDataConverter({ keys: testKeys, currentKeyId: 'test' }),
  clientDataConverter: clientDataConverter({ keys: testKeys, currentKeyId: 'test' }),
});
```

Replay tests of encrypted histories need the keys too: `assertReplays(histories, { registry, dataConverter })`.

## What is and isn't encrypted

Encrypted: payloads, meaning workflow and activity inputs and results, signal, query and update arguments and results, memos, heartbeat details, and failure details encoded as payloads.

Not encrypted: workflow IDs, workflow types, task queues, **search attributes**, and failure messages and stack traces (unless you configure a failure converter with `encodeCommonAttributes`). Don't put personal data in workflow IDs or search attributes; use opaque IDs such as `payment-p_9f2c`.

## Rotating keys

1. Generate a new key and add it to `keys` **everywhere** (workers, clients, codec server), keeping `currentKeyId` unchanged. Deploy.
2. Once every process has the new key, set `currentKeyId` to it. Deploy. New payloads use the new key; old ones still decrypt with the key named in their metadata.
3. Keep the old key until no retained history, schedule or running workflow references it: after the namespace's retention period for workflows closed before step 2, and after long-running workflows have continued as new. Then remove it.

Step 1 must reach every process before step 2: a process that receives a payload encrypted with a key it doesn't have fails with `NornCodecError` ("encrypted with key ..., which is not configured").

Enabling encryption on an existing namespace is safe: decoding passes through payloads that aren't encrypted.

## Codec server for the Temporal UI

With encryption on, the Temporal UI and `temporal` CLI show ciphertext. A **codec server** is an HTTP endpoint they call to decode payloads for display, using your keys, so operators can read inputs and results in the browser while the server never sees plaintext.

`@norn/hono` ships one as a Hono sub-app:

```ts
import { Hono } from 'hono';
import { createEncryptionCodec } from '@norn/codec';
import { codecServer } from '@norn/hono/codec-server';
import { currentKeyId, keys } from './codec.js';

const app = new Hono();
app.route(
  '/codec',
  codecServer({
    codec: createEncryptionCodec({ keys, currentKeyId }),
    // required
    auth: async (c) => verifyStaffToken(c.req.header('authorization')),
    cors: { origins: ['https://temporal.internal.example.com'] },
    namespaces: ['production'],
  }),
);
export default app;
```

It serves `POST /encode` and `POST /decode` in the codec server protocol, with CORS preflight handling for browser origins (default `https://cloud.temporal.io` and `http://localhost:8233`), a namespace allow-list (from the `X-Namespace` header) and a required `auth` hook. Anyone who passes `auth` can decrypt your payloads, and restrict `cors.origins` to your Temporal UI. Then point the UI at it: in Temporal Cloud under the namespace's codec server settings, or for a self-hosted UI with `TEMPORAL_CODEC_ENDPOINT=https://api.example.com/codec`. The `@norn/hono/codec-server` entry point has no Temporal client dependency, so it can run on edge runtimes. Options are listed in the [Hono guide](/guide/hono#codec-server).

If you use other codecs too (for example compression), pass them all in the order your data converter applies them: `codec: [compressionCodec, encryptionCodec]`.

## Payload format

For other-language consumers: an encrypted payload has metadata `encoding: binary/encrypted` and `encryption-key-id: <id>`, and data `IV (12 bytes) || AES-256-GCM ciphertext || tag (16 bytes)`. The plaintext is the original `temporal.api.common.v1.Payload` serialised as protobuf (so the original encoding is hidden too), and the additional authenticated data is the UTF-8 key ID. Tagged JSON values look like `{"$norn":"bigint","v":"123"}`. Details are in the [`@norn/codec` README](https://github.com/jamie-wk/norn/tree/main/packages/codec#format).

## Security notes

- Keys are imported as non-extractable WebCrypto keys, and error messages name key IDs but never include key material. Key IDs are stored in plaintext, so don't put secrets in them.
- Each payload gets a fresh random IV. Rotate keys well before about 2³² encryptions per key.
- GCM detects tampering, but it doesn't stop a payload being replayed into another place in history, and metadata outside the envelope (like the key ID) is visible to the server.
