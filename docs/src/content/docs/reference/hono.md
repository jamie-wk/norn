---
title: "@norn-ts/hono"
description: "Hono middleware, error handler, webhook handler and Temporal codec server for Norn."
sidebar:
  order: 10
---

[Hono](https://hono.dev) integration for Norn:

- **`temporal()`**: `c.var.norn` (a `NornClient`) plus a per-request correlation ID that follows workflow calls into workflows, activities and logs.
- **`nornErrorHandler()`**: an `app.onError(...)` handler that maps every Norn error code to an HTTP status and a stable JSON body.
- **`temporalWebhook()`** and **`hmacSha256Verifier()`**: verified webhooks become typed signals and updates, with retry-safe responses.
- **`codecServer()`**: `POST /encode` and `/decode` for the Temporal UI and `temporal` CLI, with auth, namespace checks and CORS.

For a walkthrough, see the [Hono guide](/norn/guides/hono/).

## Install

```sh
pnpm add @norn-ts/hono @norn-ts/client hono @temporalio/client @temporalio/common
```

Requires Node 22.18+ for the client parts. The package itself uses only Web-standard APIs (`Request`, `Response`, `crypto.subtle`, `TextEncoder`, `atob`/`btoa`), so it runs on Node, Bun and Deno. `@norn-ts/hono/codec-server` has no Temporal client or Node dependency and also runs on [edge runtimes](#edge-runtimes).

| Entry point | Contains |
| --- | --- |
| `@norn-ts/hono` | Everything below. Needs the Temporal client, so it requires Node (or Bun/Deno with Node compatibility). |
| `@norn-ts/hono/codec-server` | `codecServer()`, `DEFAULT_CODEC_ORIGINS`, `CodecServerOptions`, `JsonPayload`. Imports only hono and `@norn-ts/core`. |

## Setup

```ts
import { Hono } from 'hono';
import { nornErrorHandler, temporal, type NornEnv } from '@norn-ts/hono';
import { Orders } from './.norn/contracts.js';

const app = new Hono<NornEnv>();

const norn = temporal({ address: process.env.TEMPORAL_ADDRESS, namespace: 'orders' });
app.use(norn);
app.onError(nornErrorHandler());

app.post('/orders', async (c) => {
  const input = await c.req.json();
  // 409 JSON if it is already running
  const handle = await c.var.norn.workflow(Orders).start(input);
  return c.json({ workflowId: handle.workflowId }, 201);
});

app.post('/orders/:orderId/items', async (c) => {
  const { sku } = await c.req.json();
  const count = await c.var.norn.workflow(Orders).get({ orderId: c.req.param('orderId') }).update('addItem', sku);
  // 404 if the order does not exist, 422 if the validator rejects the SKU
  return c.json({ count });
});

export default app;

// On shutdown (Node): close the client the middleware created.
process.on('SIGTERM', () => void norn.close());
```

## `temporal(options)`

```ts
function temporal(options: TemporalOptions): TemporalMiddleware;

type TemporalOptions = ({ client: NornClient } | (ClientOptions & { client?: undefined })) & CorrelationOptions;

interface CorrelationOptions {
  // default 'x-correlation-id'
  correlationHeader?: string;
  // default 'x-request-id'; false disables it
  requestIdHeader?: string | false;
  // default true
  trustIncoming?: boolean;
}

interface TemporalMiddleware extends MiddlewareHandler<NornEnv> {
  readonly client: NornClient;
  close(): Promise<void>;
}

interface NornVariables {
  norn: NornClient;
  correlationId: string;
}
type NornEnv = { Variables: NornVariables };
```

| Option | Default | Description |
| --- | --- | --- |
| `client` | none | An existing client from `createClient()`. |
| `ClientOptions` fields | | Instead of `client`: `address`, `namespace`, `apiKey`, `tls`, `dataConverter`, ... from [`@norn-ts/client`](/norn/reference/client/). |
| `correlationHeader` | `'x-correlation-id'` | Request header read for an incoming correlation ID, and response header the ID is echoed in. |
| `requestIdHeader` | `'x-request-id'` | Fallback request header for an incoming ID. `false` disables it. |
| `trustIncoming` | `true` | Accept correlation IDs sent by callers (after validation). |

- With `ClientOptions`, one client is created lazily on the first request (or the first read of `.client`) and reused. `close()` closes it; it does nothing for a client you passed in, or when the client was never created.
- Invalid header names, a non-boolean `trustIncoming`, or a `client` that is not a Norn client throw `NornConfigError` when `temporal()` is called.
- Use `new Hono<NornEnv>()` to get `c.var.norn` and `c.var.correlationId` typed. To combine with your own variables: `new Hono<{ Variables: NornVariables & { user: User } }>()`.

### Correlation IDs

Every request runs inside `runWithCorrelationId(id)`, so any workflow started, signaled, queried or updated while handling it carries the ID in the `norn-correlation-id` header. Norn workers pass it on to activities and their logs. The ID is:

1. the `x-correlation-id` request header (or your `correlationHeader`), else
2. the `x-request-id` header (or your `requestIdHeader`), else
3. `c.var.requestId` from hono's [`requestId()`](https://hono.dev/docs/middleware/builtin/request-id) middleware, if you use it before `temporal()`, else
4. a new `crypto.randomUUID()`.

Incoming IDs are only accepted if they are 1–128 characters of `[A-Za-z0-9._:-]`. Anything else is skipped (the next candidate is tried, ending with a fresh UUID), so callers cannot inject arbitrary text into your logs and headers. Set `trustIncoming: false` to always generate a fresh ID, for public APIs where callers should not choose it.

The ID is available as `c.var.correlationId` and `getCorrelationId()` (re-exported from `@norn-ts/client`). It is echoed in the correlation response header on every response, including errors and 404s. A header the handler set itself is kept.

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
| `WORKFLOW_FAILED` | 500 | `result()` / `execute()` of a workflow that failed, was canceled, terminated or timed out. `details`: `workflowId`, `failureType` |
| `TEMPORAL_UNAVAILABLE` | 503 | Temporal could not be reached or is rate limiting (gRPC `UNAVAILABLE` / `DEADLINE_EXCEEDED` / `RESOURCE_EXHAUSTED`) |
| `CONFIG` | 500 | `NornConfigError`: invalid options or contract use (for example a missing ID template field) |
| `INTERNAL` | 500 | Any other error. Message is `Internal Server Error` unless `expose` |
| `WEBHOOK_UNVERIFIED` | 401 | `temporalWebhook()`: signature verification failed |
| `WEBHOOK_INVALID_BODY` | 400 | `temporalWebhook()`: body is not valid JSON (or your `parse` threw) |
| `WEBHOOK_TOO_LARGE` | 413 | `temporalWebhook()`: body is over `maxBodyBytes` |
| your own | its `status` | Any `new NornError(code, status, message, { details })` you throw |
| see below | its `status` | hono `HTTPException` |

Raw Temporal client errors that reach the handler (for example from calling `@temporalio/client` directly) are converted with `toNornError()` first, so a forgotten mapping still gives 503 for unavailability, 409 for an already-started workflow and so on.

### `HTTPException`

A hono `HTTPException` gets the same JSON body with its message (or the status text when the message is empty) and a code derived from its status. A status outside 400–599 is sent as 500.

| Status | Code |
| --- | --- |
| 400 | `BAD_REQUEST` |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 406 | `NOT_ACCEPTABLE` |
| 408 | `REQUEST_TIMEOUT` |
| 409 | `CONFLICT` |
| 410 | `GONE` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `UNPROCESSABLE_CONTENT` |
| 429 | `TOO_MANY_REQUESTS` |
| 500 | `INTERNAL` |
| 503 | `SERVICE_UNAVAILABLE` |
| any other | `HTTP_<status>` |

An `HTTPException` created with its own `res` is sent as that response (only the correlation header is added); `status` overrides and `format` do not apply to it. `HTTPException`s are passed to `onError` but are never logged by the default `console.error`, since they are thrown on purpose.

### `nornErrorHandler(options?)`

```ts
function nornErrorHandler<E extends Env = any>(options?: NornErrorHandlerOptions<E>): ErrorHandler<E>;

interface NornErrorHandlerOptions<E extends Env = any> {
  status?: Partial<Record<NornErrorCode, number>>;
  expose?: boolean | ((err: unknown) => boolean);
  onError?: (err: unknown, c: Context<E>) => void | Promise<void>;
  format?: (err: NornError, c: Context<E>, info: ErrorFormatInfo) => Response | Promise<Response>;
  correlationHeader?: string;
}

interface ErrorFormatInfo {
  status: number;
  correlationId: string;
  body: NornErrorBody;
  original: unknown;
}
```

| Option | Default | Description |
| --- | --- | --- |
| `status` | `{}` | Status overrides per code, such as `{ WORKFLOW_CLOSED: 410 }`. Must be integers from 400 to 599 (checked at startup). A `NornError` with a status outside that range is sent as 500. |
| `expose` | `false` | Return the message of non-Norn errors (500 `INTERNAL`). Use a function to expose selectively, such as `expose: () => process.env.NODE_ENV !== 'production'`. |
| `onError` | log `INTERNAL` errors with `console.error` | Called (and awaited) with every error as thrown, before responding. Errors it throws are swallowed. Without it, unexpected (`INTERNAL`) errors are logged with `console.error`, like hono's default handler. |
| `format` | none | Build the response yourself, such as RFC 9457 problem details. It gets the normalized `NornError` (unknown errors arrive as code `INTERNAL` with the original as `cause`), the status after overrides, the correlation ID, the default body and the original error. |
| `correlationHeader` | `'x-correlation-id'` | Response header for the correlation ID, only used when the request did not go through `temporal()`. A correlation ID is then generated for the error response. `temporal()` sets its own header. |

Invalid options throw `NornConfigError` when `nornErrorHandler()` is called.

```ts
nornErrorHandler({
  format: (err, c, { status, correlationId }) =>
    c.json({ type: `https://errors.example.com/${err.code}`, title: err.message, status, ...err.details, correlationId }, status as 400, {
      'content-type': 'application/problem+json',
    }),
});
```

`errorBody(err, correlationId)` builds the default body (`NornErrorBody`) if you want it in your own responses.

```ts
type NornErrorCode =
  | 'CONFIG'
  | 'WORKFLOW_ALREADY_STARTED'
  | 'WORKFLOW_NOT_FOUND'
  | 'WORKFLOW_CLOSED'
  | 'UPDATE_REJECTED'
  | 'QUERY_FAILED'
  | 'WORKFLOW_FAILED'
  | 'TEMPORAL_UNAVAILABLE'
  | 'INTERNAL'
  | 'WEBHOOK_UNVERIFIED'
  | 'WEBHOOK_INVALID_BODY'
  | 'WEBHOOK_TOO_LARGE'
  // custom NornError codes
  | (string & {});

interface NornErrorBody {
  error: { code: string; message: string; details: Record<string, unknown>; correlationId: string };
}
```

## Webhooks

`temporalWebhook()` turns inbound webhooks (payment providers, carriers, CI, ...) into signals and updates:

```ts
import { hmacSha256Verifier, signalAction, temporalWebhook } from '@norn-ts/hono';

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
          // not interesting: 202, nothing sent
          return null;
      }
    },
  }),
);
```

For each request it:

1. reads the raw body once (as text and as the exact bytes): 413 `WEBHOOK_TOO_LARGE` past `maxBodyBytes`, before `verify` runs,
2. calls `verify` (unless it is `false`): 401 `WEBHOOK_UNVERIFIED` unless it returns `true`,
3. parses it (`JSON.parse`, or your `parse`): 400 `WEBHOOK_INVALID_BODY` if that throws,
4. calls `map` to get actions; every action is checked, and every workflow ID resolved, before any is sent,
5. sends the actions in order with `c.var.norn` (or `client`), and responds.

| Outcome | Status | Body |
| --- | --- | --- |
| Actions sent | 202 | `{ accepted: n }`, plus `ignored: m` (a count) if some were skipped, plus `results` if there were updates |
| `map` returned `null`, `undefined` or `[]` | 202 | `{ accepted: 0, ignored: 'unmapped' }` |
| Workflow already closed (default `onClosed: 'ignore'`) | 200 | `{ ignored: 'closed' }` |
| Workflow not found with `onNotFound: 'ignore'` | 200 | `{ ignored: 'not_found' }` |
| Workflow not found (default `onNotFound: 'error'`) | via `app.onError` | 404 `WORKFLOW_NOT_FOUND` with `nornErrorHandler()` (status overrides apply) |
| Workflow closed with `onClosed: 'error'` | via `app.onError` | 409 `WORKFLOW_CLOSED` with `nornErrorHandler()` (status overrides apply) |
| Verification failed | 401 | `WEBHOOK_UNVERIFIED` error body |
| Unparseable body | 400 | `WEBHOOK_INVALID_BODY` error body |
| Body over `maxBodyBytes` | 413 | `WEBHOOK_TOO_LARGE` error body |
| Malformed action from `map`, or no client | via `app.onError` | 500 `CONFIG` (`NornConfigError`) |
| Anything else (Temporal down, `map` threw, ...) | via `app.onError` | such as 503 `TEMPORAL_UNAVAILABLE` |

The 200 `ignored` responses apply when no action was accepted; the body names the first skipped action's reason.

Why these defaults: providers retry any non-2xx response, usually for days. A late or duplicate delivery for a workflow that has already finished must not be retried forever, so closed workflows are acknowledged with 200. A workflow that does not exist (yet) is a 404 so it does get retried, which also covers an event racing ahead of the request that starts the workflow. Temporal being unavailable becomes a 503 through your error handler, so the provider retries later.

### `temporalWebhook(options)`

```ts
function temporalWebhook<E extends Env = any>(options: WebhookOptions<E>): Handler<E>;

interface WebhookOptions<E extends Env = any> {
  verify: ((c: Context<E>, rawBody: string, rawBytes: Uint8Array) => boolean | Promise<boolean>) | false;
  maxBodyBytes?: number;
  parse?: (rawBody: string, c: Context<E>) => unknown;
  map: (body: unknown, c: Context<E>) => WebhookMapResult | Promise<WebhookMapResult>;
  onClosed?: WebhookFailurePolicy<E, WorkflowClosedError>;
  onNotFound?: WebhookFailurePolicy<E, WorkflowNotFoundError>;
  client?: NornClient;
}

type WebhookFailurePolicy<E extends Env, Err extends NornError> =
  | 'ignore'
  | 'error'
  | ((info: WebhookFailureInfo<Err>, c: Context<E>) => Response | void | Promise<Response | void>);

type WebhookMapResult = WebhookAction | readonly WebhookAction[] | null | undefined;

interface WebhookFailureInfo<Err extends NornError> {
  action: WebhookAction;
  // position of the action in the list map returned
  index: number;
  error: Err;
}
```

| Option | Default | Description |
| --- | --- | --- |
| `verify` | required | Checks the request is genuine, such as with [`hmacSha256Verifier()`](#signature-verification). Gets the raw body as text and as the exact bytes. `false` only when something in front already verifies. |
| `maxBodyBytes` | 1 MiB | Largest body accepted. Must be a positive integer. |
| `parse` | `JSON.parse` | Parses the raw body, for non-JSON webhooks. Form-encoded: `parse: (raw) => Object.fromEntries(new URLSearchParams(raw))`. |
| `map` | required | Maps the parsed body to actions. |
| `onClosed` | `'ignore'` | What to do when the workflow is already closed. |
| `onNotFound` | `'error'` | What to do when the workflow does not exist. |
| `client` | `c.var.norn` | The client to use. Pass it when you don't use the `temporal()` middleware. |

- `'ignore'` skips the action. `'error'` stops and throws the error to `app.onError`.
- An `onClosed` / `onNotFound` function can return a `Response` to stop and send it, or nothing to skip the action and carry on.
- A missing `map` or `verify`, or an invalid option, throws `NornConfigError` when `temporalWebhook()` is called.

### Actions

Build actions with the typed helpers. Signal and update names and argument types come from the contract:

```ts
// WebhookSignalAction<typeof Orders>
signalAction(Orders, { orderId }, 'paid', { amountCents: 1999 });
signalAction(Orders, { workflowId: 'order-42' }, 'cancel', 'customer request');
// WebhookUpdateAction<typeof Orders>
updateAction(Orders, { orderId }, 'addItem', 'sku-1');
```

Or write them as objects, typed with `WebhookAction<typeof Contract>`:

```ts
const action: WebhookAction<typeof Orders> = { workflow: Orders, target: { orderId }, signal: 'paid', args: [{ amountCents: 1999 }] };
```

| Export | Description |
| --- | --- |
| `signalAction(contract, target, signal, ...args)` | Builds a `WebhookSignalAction<C>`. |
| `updateAction(contract, target, update, ...args)` | Builds a `WebhookUpdateAction<C>`. |
| `WebhookAction<C>` | `WebhookSignalAction<C> \| WebhookUpdateAction<C>`. |
| `WebhookUpdateResult<C, K>` | The result type of update `K`, for typing `results` on the caller side. |

`target` is the contract's ID fields (`{ orderId }`) or `{ workflowId, runId? }`. `args` may be left out for handlers without arguments. An action has exactly one of `signal` or `update`. Return an array to send several actions, possibly to different workflows. They are sent one after another, and the first failure stops the rest.

Update actions wait for the update to complete and return its result in `results` (aligned with the actions, `null` for signals and skipped actions):

```json
{ "accepted": 2, "results": [null, { "captured": 1999 }] }
```

A rejected update (validator) goes to `app.onError` as 422 `UPDATE_REJECTED`. Prefer signals for webhooks unless you need the result, because a 4xx makes the provider retry.

:::caution
Webhooks are delivered at least once, so make handlers idempotent: deduplicate by the provider's event ID in the workflow (for example, keep a set of processed event IDs in workflow state). When one event maps to several actions and a later one fails, the provider's retry resends the earlier ones too.
:::

### Signature verification

```ts
function hmacSha256Verifier(options: HmacSha256VerifierOptions): (c: Context, rawBody: string, rawBytes?: Uint8Array) => Promise<boolean>;

interface HmacSha256VerifierOptions {
  secret: string | Uint8Array;
  header: string;
  encoding?: 'hex' | 'base64';
  prefix?: string;
}
```

`hmacSha256Verifier()` checks an HMAC-SHA256 of the exact raw body bytes, sent in a header. It uses WebCrypto and a constant-time comparison. A missing, malformed or wrong signature returns `false` (401).

| Option | Default | Description |
| --- | --- | --- |
| `secret` | required | String (UTF-8) or `Uint8Array`. Must not be empty. A `Uint8Array` is copied, so later changes to it have no effect. |
| `header` | required | Request header that carries the signature, such as `x-hub-signature-256`. Its value is trimmed. |
| `encoding` | `'hex'` | `'hex'` (either case) or `'base64'` (standard or URL-safe, padding optional). |
| `prefix` | `''` | A prefix the header value must start with, such as `sha256=`. |

Invalid options throw `NornConfigError`.

```ts
// GitHub: X-Hub-Signature-256: sha256=<hex>
hmacSha256Verifier({ secret: env.GITHUB_WEBHOOK_SECRET, header: 'x-hub-signature-256', prefix: 'sha256=' });

// Shopify: X-Shopify-Hmac-Sha256: <base64>
hmacSha256Verifier({ secret: env.SHOPIFY_WEBHOOK_SECRET, header: 'x-shopify-hmac-sha256', encoding: 'base64' });
```

### Custom verifiers

For schemes that sign more than the body, such as timestamped signatures (`t=<unix>,v1=<hex>` over `"<t>.<body>"`), write `verify` with the exported helpers, and reject old timestamps to stop replays:

| Export | Description |
| --- | --- |
| `hmacSha256(secret, data)` | `Promise<Uint8Array>`: HMAC-SHA256 of `data` with `secret` (strings as UTF-8), via WebCrypto. |
| `timingSafeEqual(a, b)` | Compares two `Uint8Array`s in time that depends only on their lengths. |

```ts
import { hmacSha256, timingSafeEqual } from '@norn-ts/hono';

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

:::caution
Mount webhook routes before any middleware that reads the body. Hono caches parsed bodies, and a re-serialized JSON body no longer matches the signature. Consider [`bodyLimit()`](https://hono.dev/docs/middleware/builtin/body-limit) in front of them.
:::

## Codec server

When payloads are encrypted (for example with `createEncryptionCodec` / `clientDataConverter` from [`@norn-ts/codec`](/norn/reference/codec/)), the Temporal UI and CLI show ciphertext until they can call a [codec server](https://docs.temporal.io/production-deployment/data-encryption). `codecServer()` is one, as a Hono sub-app:

```ts
import { Hono } from 'hono';
import { codecServer } from '@norn-ts/hono/codec-server';
import { createEncryptionCodec } from '@norn-ts/codec';

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

Pass the same codecs your clients and workers use, in the same order: `codec: clientDataConverter({ keys, currentKeyId }).payloadCodecs` works too. Encoding applies them in order and decoding in reverse, as Temporal SDKs do. Payloads that are not encrypted pass through decoding untouched. See also [Encryption](/norn/guides/encryption/#codec-server-for-the-temporal-ui).

### Protocol

`POST /encode` and `POST /decode` take and return `{ "payloads": [{ "metadata": { "encoding": "<base64>" }, "data": "<base64>" }] }`: the proto3 JSON form of `temporal.api.common.v1.Payload` (exported as the `JsonPayload` type). Base64 may be standard or URL-safe, with or without padding; responses use standard, padded base64.

Each request is checked in this order: origin (CORS), `auth`, namespace, body size, body shape.

| Status | Code | When |
| --- | --- | --- |
| 200 | — | `{ payloads: [...] }` |
| 400 | `INVALID_PAYLOADS` | Body is not JSON or not `{ payloads: [...] }` with base64 strings |
| 400 | `CODEC_FAILED` | The codec rejected a payload with a `NornCodecError` (unknown key id, tampered data) |
| 401 | `UNAUTHORIZED` | `auth` returned anything but `true`, or threw |
| 403 | `FORBIDDEN_ORIGIN` | Request or preflight from an origin that is not allowed |
| 403 | `FORBIDDEN_NAMESPACE` | `X-Namespace` missing or not in `namespaces` |
| 413 | `PAYLOAD_TOO_LARGE` | Body is over `maxBodyBytes` |
| 500 | `INTERNAL` | Any other codec error, or a codec returned the wrong number of payloads (message not exposed) |

Errors use the body `{ error: { code, message, details } }`.

### `codecServer(options)`

```ts
function codecServer<E extends Env = any>(options: CodecServerOptions<E>): Hono<E>;

interface CodecServerOptions<E extends Env = any> {
  codec: PayloadCodec | PayloadCodec[];
  auth: ((c: Context<E>) => boolean | Promise<boolean>) | false;
  cors?: { origins: string[] } | false;
  maxBodyBytes?: number;
  namespaces?: string[];
  onError?: (err: unknown, c: Context<E>) => void;
}
```

| Option | Default | Description |
| --- | --- | --- |
| `codec` | required | A `PayloadCodec` or a non-empty array of them, in the order your data converter applies them. |
| `auth` | required | Runs before the body is read. Return `true` to allow. Throwing counts as unauthenticated (and is passed to `onError`). Pass `false` only when something in front of the server (a gateway, a private network) already authenticates callers. |
| `cors` | `{ origins: DEFAULT_CODEC_ORIGINS }` | Browser origins allowed to call the server. See below. |
| `maxBodyBytes` | 16 MiB | Largest request body accepted. Must be a positive integer. |
| `namespaces` | any | Allowed values of the `X-Namespace` header the Temporal UI sends. When set (a non-empty array), requests without it are refused. |
| `onError` | none | Called with `auth` and codec errors, such as for logging. Errors it throws are ignored. It never receives payload contents (unless your own codec puts them in its error messages). |

Invalid options (including a `cors` origin that is not an `http(s)` URL) throw `NornConfigError` when `codecServer()` is called.

`DEFAULT_CODEC_ORIGINS` is `['https://cloud.temporal.io', 'http://localhost:8233']` (Temporal Cloud and the dev server UI). CORS behavior:

- Allowed origins get `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Credentials: true` and `Vary: Origin` on every response, errors included, so the UI can show them.
- Preflights (`OPTIONS`) get 204 with `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers: content-type, x-namespace, authorization` and a 10-minute max age, without calling `auth`.
- Requests from other origins get 403 `FORBIDDEN_ORIGIN`.
- Requests without an `Origin` header (the CLI, servers) are not affected.
- `'*'` allows any origin, answered with `Access-Control-Allow-Origin: *` and without credentials, so cookies are never sent cross-site.
- `cors: false` turns all of this off, for CLI-only servers or when you handle CORS yourself.

### Connecting the Temporal UI and CLI

Point them at the mount path. They append `/encode` and `/decode`.

- **Temporal Cloud**: Namespace → *Codec Server* → endpoint `https://api.example.com/codec`. Enable *Pass the user access token* to receive `Authorization: Bearer <the user's Temporal Cloud token>` in `auth` (verify it as a JWT against Temporal Cloud's JWKS), or *Include cross-origin credentials* to receive your own cookies. Users can also set a personal endpoint in the UI's *Data Encoder* settings.
- **Self-hosted UI** (`temporalio/ui`): set `TEMPORAL_CODEC_ENDPOINT=https://api.example.com/codec`, plus `TEMPORAL_CODEC_PASS_ACCESS_TOKEN=true` and/or `TEMPORAL_CODEC_INCLUDE_CREDENTIALS=true` as needed (or `codec.endpoint`, `codec.passAccessToken`, `codec.includeCredentials` in the UI server config). Add the UI's origin to `cors.origins`.
- **Dev server**: `temporal server start-dev --ui-codec-endpoint http://localhost:3000/codec` (UI on `http://localhost:8233`, allowed by default).
- **CLI**: `temporal workflow show -w order-42 --codec-endpoint https://api.example.com/codec --codec-auth "Bearer $CODEC_TOKEN"`, or the `TEMPORAL_CODEC_ENDPOINT` / `TEMPORAL_CODEC_AUTH` environment variables. If you restrict `namespaces`, add `--codec-header X-Namespace=orders-prod`.

### Edge runtimes

`@norn-ts/hono/codec-server` imports only hono and `@norn-ts/core` (no Temporal client, no Node APIs), and `createEncryptionCodec` uses WebCrypto only, so the codec server can run on Cloudflare Workers, Deno Deploy, Vercel Edge and similar:

```ts
// Cloudflare Workers
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { codecServer } from '@norn-ts/hono/codec-server';
import { createEncryptionCodec } from '@norn-ts/codec/encryption';

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

Import `createEncryptionCodec` from `@norn-ts/codec/encryption` there: it only uses WebCrypto, while the main `@norn-ts/codec` entry also contains the worker helper `resolvePayloadConverterPath()`, which imports `node:url`. The main `@norn-ts/hono` entry needs the Temporal client, which requires Node (or Bun/Deno with Node compatibility).

## Security notes

- **Correlation IDs** from clients are validated (1–128 chars of `[A-Za-z0-9._:-]`) and otherwise replaced. Use `trustIncoming: false` if callers must not choose them at all. They are not secrets and not authentication.
- **Error responses** never include stacks or causes. `NornError` messages and details are designed to be returned to callers; messages of other errors are hidden unless you set `expose`. 5xx Norn errors (`WORKFLOW_FAILED`, `QUERY_FAILED`, `TEMPORAL_UNAVAILABLE`, `CONFIG`) do include their message; use `format` to hide them if your workflow failure messages are internal.
- **Webhooks**: `verify` is required. `verify: false` is for endpoints already verified upstream, since without verification anyone can signal your workflows. Bodies over `maxBodyBytes` (default 1 MiB) are refused before they are fully read. Signatures are checked over the exact bytes received, with a constant-time comparison. HMAC alone does not stop replays: prefer providers' timestamped schemes, reject old timestamps, and deduplicate by event ID. Keep webhook secrets in your secret manager and rotate them with your provider.
- **Codec server**: anyone who can call `/decode` can read every payload you send it. `auth` is required (for Temporal Cloud, verify the passed access token); restrict `namespaces` and keep `cors.origins` to your UI origins. `'*'` never sends credentials, so it can't be combined with cookie-based auth. Serve it over HTTPS only. It never logs payloads; make sure your own logging (`onError`, access logs with bodies) does not either.
- The codec server holds your encryption keys: deploy it with the same care as workers, and see [key rotation](/norn/reference/codec/#key-rotation).

## Exports

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
| `hmacSha256Verifier(options)`, `HmacSha256VerifierOptions` | `verify` for HMAC-SHA256 header signatures |
| `hmacSha256(secret, data)`, `timingSafeEqual(a, b)` | WebCrypto helpers for custom verifiers |
| `codecServer(options)` | Codec server sub-app (also `@norn-ts/hono/codec-server`) |
| `CodecServerOptions`, `JsonPayload`, `DEFAULT_CODEC_ORIGINS` | Codec server types and defaults |
| `getCorrelationId()`, `runWithCorrelationId(id, fn)`, `NornClient` | Re-exported from [`@norn-ts/client`](/norn/reference/client/) |
