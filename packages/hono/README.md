# @norn/hono

[Hono](https://hono.dev) integration for [Norn](https://jamie-wk.github.io/norn/): a middleware that puts a typed Temporal client and a correlation ID on every request, an error handler that turns Norn and Temporal errors into JSON responses with the right status, a handler that turns inbound webhooks into signals and updates, and a Temporal codec server for the Temporal UI and CLI.

- **`temporal()`**: `c.var.norn` (a `NornClient`) plus a per-request correlation ID that follows workflow calls into workflows, activities and logs.
- **`nornErrorHandler()`**: `app.onError(...)` mapping every Norn error code to an HTTP status and a stable JSON body.
- **`temporalWebhook()`** and **`hmacSha256Verifier()`**: verified webhooks → typed signals and updates, with retry-safe responses.
- **`codecServer()`**: `POST /encode` and `/decode` for the Temporal UI and `temporal` CLI, with auth, namespace checks and CORS.

## Install

```sh
pnpm add @norn/hono @norn/client hono @temporalio/client @temporalio/common
```

Requires Node 22.18+ for the client parts. The package itself uses only Web-standard APIs (`Request`, `Response`, `crypto.subtle`, `TextEncoder`, `atob`/`btoa`), so it runs on Node, Bun and Deno; `@norn/hono/codec-server` has no Temporal client or Node dependency and also runs on edge runtimes (see [Codec server](#codec-server)).

## Setup

```ts
import { Hono } from 'hono';
import { nornErrorHandler, temporal, type NornEnv } from '@norn/hono';
import { Orders } from './.norn/contracts.js';

const app = new Hono<NornEnv>();

const norn = temporal({ address: process.env.TEMPORAL_ADDRESS, namespace: 'orders' });
app.use(norn);
app.onError(nornErrorHandler());

app.post('/orders', async (c) => {
  const input = await c.req.json();
  const handle = await c.var.norn.workflow(Orders).start(input); // 409 JSON if it is already running
  return c.json({ workflowId: handle.workflowId }, 201);
});

app.post('/orders/:orderId/items', async (c) => {
  const { sku } = await c.req.json();
  const count = await c.var.norn.workflow(Orders).get({ orderId: c.req.param('orderId') }).update('addItem', sku);
  return c.json({ count }); // 404 if the order does not exist, 422 if the validator rejects the SKU
});

export default app;

// On shutdown (Node): close the client the middleware created.
process.on('SIGTERM', () => void norn.close());
```

### `temporal(options)`

```ts
function temporal(options: TemporalOptions): TemporalMiddleware;

type TemporalOptions = ({ client: NornClient } | ClientOptions) & {
  correlationHeader?: string; // default 'x-correlation-id'
  requestIdHeader?: string | false; // default 'x-request-id'
  trustIncoming?: boolean; // default true
};

interface TemporalMiddleware extends MiddlewareHandler<NornEnv> {
  readonly client: NornClient;
  close(): Promise<void>;
}

type NornEnv = { Variables: { norn: NornClient; correlationId: string } };
```

- Pass an existing client (`{ client: createClient(...) }`) or `ClientOptions` from `@norn/client` (`address`, `namespace`, `apiKey`, `tls`, `dataConverter`, ...). With options, one client is created lazily on the first request and reused; `close()` closes it. `close()` never closes a client you passed in.
- Use `new Hono<NornEnv>()` to get `c.var.norn` and `c.var.correlationId` typed. To combine with your own variables: `new Hono<{ Variables: NornVariables & { user: User } }>()`.

### Correlation IDs

Every request runs inside `runWithCorrelationId(id)`, so any workflow started, signalled, queried or updated while handling it carries the ID in the `norn-correlation-id` header, which Norn workers pass on to activities and their logs. The ID is:

1. the `x-correlation-id` request header (or your `correlationHeader`), else
2. the `x-request-id` header (or your `requestIdHeader`), else
3. `c.var.requestId` from hono's [`requestId()`](https://hono.dev/docs/middleware/builtin/request-id) middleware, if you use it before `temporal()`, else
4. a new `crypto.randomUUID()`.

Incoming IDs are only accepted if they are 1–128 characters of `[A-Za-z0-9._:-]`; anything else is skipped (the next candidate is tried, ending with a fresh UUID), so callers cannot inject arbitrary text into your logs and headers. Set `trustIncoming: false` to always generate a fresh ID, for public APIs where callers should not choose it.

The ID is available as `c.var.correlationId` and `getCorrelationId()` (re-exported from `@norn/client`), and echoed in the `x-correlation-id` response header on every response, including errors and 404s (a header the handler set itself is kept).

## Errors

```ts
app.onError(
  nornErrorHandler({
    status: { WORKFLOW_CLOSED: 410 },
    onError: (err, c) => logger.error({ err, correlationId: c.var.correlationId }),
  }),
);
```

Every error becomes:

```json
{ "error": { "code": "WORKFLOW_NOT_FOUND", "message": "Workflow order-42 was not found", "details": { "workflowId": "order-42" }, "correlationId": "4f0c…" } }
```

with the correlation ID also in the `x-correlation-id` header. Stacks and causes are never included.

| Code | Status | When |
| --- | --- | --- |
| `WORKFLOW_ALREADY_STARTED` | 409 | `start()` with an ID that is running (or closed, with `ifClosed: 'reject'`). `details`: `workflowId`, `workflowType` |
| `WORKFLOW_NOT_FOUND` | 404 | No workflow with that ID (signal, query, update, describe, result, cancel). `details`: `workflowId`, `runId?` |
| `WORKFLOW_CLOSED` | 409 | Signal, update or cancel on a workflow that already finished. `details`: `workflowId`, `closeStatus` |
| `UPDATE_REJECTED` | 422 | An update validator rejected the input, or the handler threw. `details`: `workflowId`, `update`, `failureType` |
| `QUERY_FAILED` | 500 | Unknown or failing query. `details`: `workflowId`, `query` |
| `WORKFLOW_FAILED` | 500 | `result()` / `execute()` of a workflow that failed, was cancelled, terminated or timed out. `details`: `workflowId`, `failureType` |
| `TEMPORAL_UNAVAILABLE` | 503 | Temporal could not be reached (gRPC `UNAVAILABLE` / `DEADLINE_EXCEEDED`) |
| `CONFIG` | 500 | `NornConfigError`: invalid options or contract use (for example a missing ID template field) |
| `INTERNAL` | 500 | Any other error. Message is `Internal Server Error` unless `expose` |
| `WEBHOOK_UNVERIFIED` | 401 | `temporalWebhook()`: signature verification failed |
| `WEBHOOK_INVALID_BODY` | 400 | `temporalWebhook()`: body is not valid JSON (or your `parse` threw) |
| your own | its `status` | Any `new NornError(code, status, message, { details })` you throw |
| — | its own | hono `HTTPException`: its own response, exactly as hono's default handler |

Raw Temporal client errors that reach the handler (for example from calling `@temporalio/client` directly) are converted with `toNornError()` first, so a forgotten mapping still gives 503 for unavailability, 409 for an already-started workflow and so on.

### `nornErrorHandler(options?)`

```ts
function nornErrorHandler<E extends Env = any>(options?: {
  status?: Partial<Record<NornErrorCode, number>>;
  expose?: boolean | ((err: unknown) => boolean);
  onError?: (err: unknown, c: Context<E>) => void | Promise<void>;
  format?: (err: NornError, c: Context<E>, info: ErrorFormatInfo) => Response | Promise<Response>;
  correlationHeader?: string;
}): ErrorHandler<E>;

interface ErrorFormatInfo { status: number; correlationId: string; body: NornErrorBody; original: unknown }
```

- `status`: overrides per code; must be integers from 400 to 599 (checked at startup). A `NornError` with a status outside that range is sent as 500.
- `expose`: return the message of non-Norn errors (500 `INTERNAL`). Default false. Use a function to expose selectively, e.g. `expose: () => process.env.NODE_ENV !== 'production'`.
- `onError`: called (and awaited) with every error as thrown, before responding; errors it throws are swallowed. Without it, unexpected (`INTERNAL`) errors are logged with `console.error`, like hono's default handler.
- `format`: build the response yourself, e.g. RFC 9457 problem details. It gets the normalized `NornError` (unknown errors arrive as code `INTERNAL` with the original as `cause`), the status after overrides, and the default body:

  ```ts
  nornErrorHandler({
    format: (err, c, { status, correlationId }) =>
      c.json({ type: `https://errors.example.com/${err.code}`, title: err.message, status, ...err.details, correlationId }, status as 400, {
        'content-type': 'application/problem+json',
      }),
  });
  ```

- `correlationHeader`: only used when the request did not go through `temporal()` (then a correlation ID is generated for the error response); `temporal()` sets its own header.

`errorBody(err, correlationId)` builds the default body if you want it in your own responses.

## Webhooks

`temporalWebhook()` turns inbound webhooks (payment providers, carriers, CI, ...) into signals and updates:

```ts
import { hmacSha256Verifier, signalAction, temporalWebhook } from '@norn/hono';

app.post(
  '/webhooks/payments',
  temporalWebhook<NornEnv>({
    verify: hmacSha256Verifier({ secret: process.env.PAYMENTS_WEBHOOK_SECRET!, header: 'x-signature', prefix: 'sha256=' }),
    map: (body) => {
      const event = body as PaymentEvent;
      switch (event.type) {
        case 'payment.succeeded':
          return signalAction(Orders, { orderId: event.data.orderId }, 'paid', { amountCents: event.data.amount });
        case 'payment.failed':
          return signalAction(Orders, { orderId: event.data.orderId }, 'paymentFailed', event.data.reason);
        default:
          return null; // not interesting: 202, nothing sent
      }
    },
  }),
);
```

For each request it:

1. reads the raw body once (as text and as the exact bytes),
2. calls `verify` → 401 `WEBHOOK_UNVERIFIED` unless it returns `true`,
3. parses it (`JSON.parse`, or your `parse`) → 400 `WEBHOOK_INVALID_BODY` if that throws,
4. calls `map` → actions; every action is checked before any is sent,
5. sends the actions in order with `c.var.norn` (or `client`), and responds.

| Outcome | Status | Body |
| --- | --- | --- |
| Actions sent | 202 | `{ accepted: n }`, plus `ignored: m` if some were skipped, plus `results` if there were updates |
| `map` returned `null`, `undefined` or `[]` | 202 | `{ accepted: 0, ignored: 'unmapped' }` |
| Workflow already closed (default `onClosed: 'ignore'`) | 200 | `{ ignored: 'closed' }` |
| Workflow not found with `onNotFound: 'ignore'` | 200 | `{ ignored: 'not_found' }` |
| Workflow not found (default `onNotFound: 'error'`) | 404 | `WORKFLOW_NOT_FOUND` error body |
| Workflow closed with `onClosed: 'error'` | 409 | `WORKFLOW_CLOSED` error body |
| Verification failed | 401 | `WEBHOOK_UNVERIFIED` error body |
| Unparseable body | 400 | `WEBHOOK_INVALID_BODY` error body |
| Anything else (Temporal down, `map` threw, ...) | via `app.onError` | e.g. 503 `TEMPORAL_UNAVAILABLE` |

Why these defaults: providers retry any non-2xx response, usually for days. A late or duplicate delivery for a workflow that has already finished must not be retried forever, so closed workflows are acknowledged with 200. A workflow that does not exist (yet) is a 404 so it does get retried, which also covers an event racing ahead of the request that starts the workflow. Temporal being unavailable becomes a 503 through your error handler, so the provider retries later.

### Options

```ts
function temporalWebhook<E extends Env = any>(options: {
  verify?: (c: Context<E>, rawBody: string, rawBytes: Uint8Array) => boolean | Promise<boolean>;
  parse?: (rawBody: string, c: Context<E>) => unknown;
  map: (body: unknown, c: Context<E>) => WebhookMapResult | Promise<WebhookMapResult>;
  onClosed?: 'ignore' | 'error' | ((info: WebhookFailureInfo<WorkflowClosedError>, c: Context<E>) => Response | void | Promise<Response | void>);
  onNotFound?: 'ignore' | 'error' | ((info: WebhookFailureInfo<WorkflowNotFoundError>, c: Context<E>) => Response | void | Promise<Response | void>);
  client?: NornClient;
}): Handler<E>;

type WebhookMapResult = WebhookAction | readonly WebhookAction[] | null | undefined;
interface WebhookFailureInfo<Err> { action: WebhookAction; index: number; error: Err }
```

- An `onClosed` / `onNotFound` function can return a `Response` to stop and send it, or nothing to skip the action and carry on.
- `parse` handles non-JSON webhooks, e.g. form-encoded: `parse: (raw) => Object.fromEntries(new URLSearchParams(raw))`.
- Without the `temporal()` middleware, pass `client`.

### Actions

Build actions with the typed helpers; signal and update names and argument types come from the contract:

```ts
signalAction(Orders, { orderId }, 'paid', { amountCents: 1999 }); // WebhookSignalAction<typeof Orders>
signalAction(Orders, { workflowId: 'order-42' }, 'cancel', 'customer request');
updateAction(Orders, { orderId }, 'addItem', 'sku-1'); // WebhookUpdateAction<typeof Orders>
```

or write them as objects, typed with `WebhookAction<typeof Contract>`:

```ts
const action: WebhookAction<typeof Orders> = { workflow: Orders, target: { orderId }, signal: 'paid', args: [{ amountCents: 1999 }] };
```

`target` is the contract's ID fields (`{ orderId }`) or `{ workflowId, runId? }`. `args` may be left out for handlers without arguments. Return an array to send several actions, possibly to different workflows; they are sent one after another, and the first failure stops the rest.

Update actions wait for the update to complete and return its result in `results` (aligned with the actions, `null` for signals):

```json
{ "accepted": 2, "results": [null, { "captured": 1999 }] }
```

A rejected update (validator) goes to `app.onError` as 422 `UPDATE_REJECTED`; prefer signals for webhooks unless you need the result, because a 4xx makes the provider retry.

Webhooks are delivered at least once, so make handlers idempotent: deduplicate by the provider's event ID in the workflow (e.g. keep a set of processed event IDs in workflow state). When one event maps to several actions and a later one fails, the provider's retry resends the earlier ones too.

### Signature verification

`hmacSha256Verifier({ secret, header, encoding?, prefix? })` checks an HMAC-SHA256 of the exact raw body bytes, sent in a header. It uses WebCrypto and a constant-time comparison; a missing, malformed or wrong signature returns `false` (401).

```ts
// GitHub: X-Hub-Signature-256: sha256=<hex>
hmacSha256Verifier({ secret: env.GITHUB_WEBHOOK_SECRET, header: 'x-hub-signature-256', prefix: 'sha256=' });

// Shopify: X-Shopify-Hmac-Sha256: <base64>
hmacSha256Verifier({ secret: env.SHOPIFY_WEBHOOK_SECRET, header: 'x-shopify-hmac-sha256', encoding: 'base64' });
```

- `secret`: string (UTF-8) or `Uint8Array`; must not be empty.
- `encoding`: `'hex'` (default, either case) or `'base64'` (standard or URL-safe, padding optional).
- `prefix`: a prefix the header value must start with, such as `sha256=`.

For schemes that sign more than the body, such as timestamped signatures (`t=<unix>,v1=<hex>` over `"<t>.<body>"`), write `verify` with the exported `hmacSha256` and `timingSafeEqual`, and reject old timestamps to stop replays:

```ts
import { hmacSha256, timingSafeEqual } from '@norn/hono';

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const utf8 = new TextEncoder();

const verify = async (c: Context, rawBody: string) => {
  const parts = new Map((c.req.header('x-provider-signature') ?? '').split(',').map((kv) => kv.split('=', 2) as [string, string]));
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isInteger(t) || !v1 || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = toHex(await hmacSha256(env.PROVIDER_SECRET, `${t}.${rawBody}`));
  return timingSafeEqual(utf8.encode(expected), utf8.encode(v1.toLowerCase()));
};
```

If the provider ships an SDK with a verification function (Stripe's `webhooks.constructEventAsync`, for example), call it from `verify`.

Mount webhook routes before any middleware that reads the body (hono caches parsed bodies, and a re-serialized JSON body no longer matches the signature), and consider [`bodyLimit()`](https://hono.dev/docs/middleware/builtin/body-limit) in front of them.

## Codec server

When payloads are encrypted (for example with `createEncryptionCodec` / `clientDataConverter` from `@norn/codec`), the Temporal UI and CLI show ciphertext until they can call a [codec server](https://docs.temporal.io/production-deployment/data-encryption). `codecServer()` is one, as a Hono sub-app:

```ts
import { Hono } from 'hono';
import { codecServer } from '@norn/hono/codec-server';
import { createEncryptionCodec } from '@norn/codec';

const app = new Hono();
app.route(
  '/codec',
  codecServer({
    codec: createEncryptionCodec({ keys: { '2026-10': env.NORN_KEY_2026_10 }, currentKeyId: '2026-10' }),
    auth: (c) => c.req.header('authorization') === `Bearer ${env.CODEC_TOKEN}`,
    namespaces: ['orders-prod'],
    cors: { origins: ['https://temporal.internal.example.com'] },
  }),
);
```

Pass the same codecs your clients and workers use, in the same order: `codec: clientDataConverter({ keys, currentKeyId }).payloadCodecs` works too. Encoding applies them in order and decoding in reverse, as Temporal SDKs do. Payloads that are not encrypted pass through decoding untouched.

### Protocol

`POST /encode` and `POST /decode`, with and returning `{ "payloads": [{ "metadata": { "encoding": "<base64>" }, "data": "<base64>" }] }` (the proto3 JSON form of `temporal.api.common.v1.Payload`; base64 may be standard or URL-safe, with or without padding).

| Status | Code | When |
| --- | --- | --- |
| 200 | — | `{ payloads: [...] }` |
| 400 | `INVALID_PAYLOADS` | Body is not JSON or not `{ payloads: [...] }` with base64 strings |
| 400 | `CODEC_FAILED` | The codec rejected a payload (e.g. `NornCodecError`: unknown key id, tampered data) |
| 401 | `UNAUTHORIZED` | `auth` returned false or threw |
| 403 | `FORBIDDEN_ORIGIN` | Request or preflight from an origin that is not allowed |
| 403 | `FORBIDDEN_NAMESPACE` | `X-Namespace` missing or not in `namespaces` |
| 500 | `INTERNAL` | Any other codec error (message not exposed) |

Errors use the body `{ error: { code, message, details } }`.

### Options

```ts
function codecServer<E extends Env = any>(options: {
  codec: PayloadCodec | PayloadCodec[];
  auth?: (c: Context<E>) => boolean | Promise<boolean>;
  cors?: { origins: string[] } | false;
  namespaces?: string[];
  onError?: (err: unknown, c: Context<E>) => void;
}): Hono<E>;
```

- `auth`: runs before the body is read. Return `true` to allow. Throwing counts as unauthenticated (and is passed to `onError`).
- `namespaces`: allowed values of the `X-Namespace` header the Temporal UI sends. When set, requests without it are refused.
- `cors`: browser origins allowed to call the server. Default `['https://cloud.temporal.io', 'http://localhost:8233']` (Temporal Cloud and the dev server UI). Allowed origins get `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Credentials: true` and `Vary: Origin` on every response (errors included, so the UI can show them); preflights (`OPTIONS`) get 204 with `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers: content-type, x-namespace, authorization` and a 10-minute max age, without calling `auth`. Requests from other origins get 403. Requests without an `Origin` header (the CLI, servers) are not affected. `'*'` allows any origin. `cors: false` turns all of this off, for CLI-only servers or when you handle CORS yourself.
- `onError`: called with `auth` and codec errors, e.g. for logging. It never receives payload contents (unless your own codec puts them in its error messages).

### Connecting the Temporal UI and CLI

Point them at the mount path; they append `/encode` and `/decode`.

- **Temporal Cloud**: Namespace → *Codec Server* → endpoint `https://api.example.com/codec`. Enable *Pass the user access token* to receive `Authorization: Bearer <the user's Temporal Cloud token>` in `auth` (verify it as a JWT against Temporal Cloud's JWKS), or *Include cross-origin credentials* to receive your own cookies. Users can also set a personal endpoint in the UI's *Data Encoder* settings.
- **Self-hosted UI** (`temporalio/ui`): set `TEMPORAL_CODEC_ENDPOINT=https://api.example.com/codec`, plus `TEMPORAL_CODEC_PASS_ACCESS_TOKEN=true` and/or `TEMPORAL_CODEC_INCLUDE_CREDENTIALS=true` as needed (or `codec.endpoint`, `codec.passAccessToken`, `codec.includeCredentials` in the UI server config). Add the UI's origin to `cors.origins`.
- **Dev server**: `temporal server start-dev --ui-codec-endpoint http://localhost:3000/codec` (UI on `http://localhost:8233`, allowed by default).
- **CLI**: `temporal workflow show -w order-42 --codec-endpoint https://api.example.com/codec --codec-auth "Bearer $CODEC_TOKEN"`, or the `TEMPORAL_CODEC_ENDPOINT` / `TEMPORAL_CODEC_AUTH` environment variables. If you restrict `namespaces`, add `--codec-header X-Namespace=orders-prod`.

### Edge runtimes

`@norn/hono/codec-server` imports only hono and `@norn/core` (no Temporal client, no Node APIs), and `createEncryptionCodec` uses WebCrypto only, so the codec server can run on Cloudflare Workers, Deno Deploy, Vercel Edge and similar:

```ts
// Cloudflare Workers
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { codecServer } from '@norn/hono/codec-server';
import { createEncryptionCodec } from '@norn/codec';

type Env = { Bindings: { NORN_KEY_2026_10: string; CODEC_TOKEN: string } };

const app = new Hono<Env>();
app.route(
  '/codec',
  codecServer<Env>({
    codec: createEncryptionCodec({ keys: { '2026-10': env.NORN_KEY_2026_10 }, currentKeyId: '2026-10' }),
    auth: (c) => c.req.header('authorization') === `Bearer ${c.env.CODEC_TOKEN}`,
  }),
);
export default app;
```

`createEncryptionCodec` itself only uses WebCrypto, but the `@norn/codec` entry point also contains the worker helper `resolvePayloadConverterPath()`, which imports `node:url`; on Cloudflare Workers enable the `nodejs_compat` compatibility flag (or bring any other `PayloadCodec`). The main `@norn/hono` entry needs the Temporal client, which requires Node (or Bun/Deno with Node compatibility).

## Security notes

- **Correlation IDs** from clients are validated (1–128 chars of `[A-Za-z0-9._:-]`) and otherwise replaced; use `trustIncoming: false` if callers must not choose them at all. They are not secrets and not authentication.
- **Error responses** never include stacks or causes. `NornError` messages and details are designed to be returned to callers; messages of other errors are hidden unless you set `expose`. Note that 5xx Norn errors (`WORKFLOW_FAILED`, `QUERY_FAILED`, `TEMPORAL_UNAVAILABLE`, `CONFIG`) do include their message; use `format` to hide them if your workflow failure messages are internal.
- **Webhooks**: always set `verify` for endpoints reachable from the internet; without it anyone can signal your workflows. Signatures are checked over the exact bytes received, with a constant-time comparison. HMAC alone does not stop replays: prefer providers' timestamped schemes and reject old timestamps, and deduplicate by event ID. Keep webhook secrets in your secret manager and rotate them with your provider.
- **Codec server**: anyone who can call `/decode` can read every payload you send it. Always set `auth` in production (for Temporal Cloud, verify the passed access token), restrict `namespaces`, and keep `cors.origins` to your UI origins (never `'*'` together with cookie-based auth). Serve it over HTTPS only. It never logs payloads; make sure your own logging (`onError`, access logs with bodies) does not either.
- The codec server holds your encryption keys: deploy it with the same care as workers, and see `@norn/codec`'s [key rotation](../codec/README.md#key-rotation) notes.

## API

| Export | Kind |
| --- | --- |
| `temporal(options)` | Middleware: `c.var.norn`, correlation IDs. Returns `TemporalMiddleware` (`client`, `close()`) |
| `NornEnv`, `NornVariables`, `TemporalOptions`, `CorrelationOptions`, `TemporalMiddleware` | Types |
| `nornErrorHandler(options?)` | `app.onError` handler |
| `errorBody(err, correlationId)` | Builds the default error body |
| `NornErrorCode`, `NornErrorBody`, `NornErrorHandlerOptions`, `ErrorFormatInfo` | Types |
| `temporalWebhook(options)` | Webhook handler |
| `signalAction(contract, target, signal, ...args)`, `updateAction(contract, target, update, ...args)` | Typed action builders |
| `WebhookAction<C>`, `WebhookSignalAction<C>`, `WebhookUpdateAction<C>`, `WebhookUpdateResult<C, K>`, `WebhookOptions`, `WebhookMapResult`, `WebhookFailureInfo`, `WebhookFailurePolicy` | Types |
| `hmacSha256Verifier(options)` | `verify` for HMAC-SHA256 header signatures |
| `hmacSha256(secret, data)`, `timingSafeEqual(a, b)` | WebCrypto helpers for custom verifiers |
| `codecServer(options)` | Codec server sub-app (also `@norn/hono/codec-server`) |
| `CodecServerOptions`, `JsonPayload`, `DEFAULT_CODEC_ORIGINS` | Codec server types and defaults |
| `getCorrelationId()`, `runWithCorrelationId(id, fn)`, `NornClient` | Re-exported from `@norn/client` |
