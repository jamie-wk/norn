# Hono integration

[`@norn/hono`](https://github.com/jamie-wk/norn/tree/main/packages/hono#readme) connects a [Hono](https://hono.dev) API to Temporal: a middleware that puts a Norn client on every request with a correlation ID, an error handler that turns Norn errors into JSON responses with the right status, a webhook handler that routes provider events to signals and updates, and a codec server for the Temporal UI.

```sh
pnpm add @norn/hono @norn/client hono @temporalio/client @temporalio/common
```

```ts
import { Hono } from 'hono';
import { hmacSha256Verifier, nornErrorHandler, signalAction, temporal, temporalWebhook, type NornEnv } from '@norn/hono';
import { PaymentWorkflow } from '../.norn/contracts.js';

const app = new Hono<NornEnv>();
// client from TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE / TEMPORAL_API_KEY
app.use(temporal({}));
app.onError(nornErrorHandler());

app.post('/payments', async (c) => {
  const input = await c.req.json<{ paymentId: string; amountCents: number }>();
  const payment = await c.var.norn.workflow(PaymentWorkflow).start(input);
  return c.json({ workflowId: payment.workflowId }, 201);
});

app.post(
  '/webhooks/transfers',
  temporalWebhook({
    verify: hmacSha256Verifier({ secret: process.env.WEBHOOK_SECRET!, header: 'x-signature' }),
    map: (event: any) => signalAction(PaymentWorkflow, { paymentId: event.data.paymentId }, 'transferEvent', event),
  }),
);

export default app;
```

## `temporal()` middleware

`temporal(options)` sets two context variables for every request, typed through `NornEnv`:

- `c.var.norn`: the Norn client.
- `c.var.correlationId`: this request's [correlation ID](#correlation-ids).

Pass either an existing client, or [client options](/guide/client#createclient-options) to create one lazily on the first request:

```ts
const norn = createClient({ dataConverter: clientDataConverter({ keys, currentKeyId }) });
app.use(temporal({ client: norn }));

// or
const middleware = temporal({ address: process.env.TEMPORAL_ADDRESS, namespace: 'payments' });
app.use(middleware);
// closes a client the middleware created
process.on('SIGTERM', () => void middleware.close());
```

`middleware.client` returns the client (creating it if needed), so other code can share it. `close()` only closes a client the middleware created, never one you passed in.

If your app has its own variables, combine the types: `new Hono<{ Variables: NornVariables & MyVariables }>()`.

### Correlation IDs

| Option | Default | Description |
| --- | --- | --- |
| `correlationHeader` | `x-correlation-id` | Request header read for an incoming ID, and response header the ID is echoed in. |
| `requestIdHeader` | `x-request-id` | Fallback request header; `false` disables it. |
| `trustIncoming` | `true` | Accept IDs sent by callers (after validation). Set `false` on public APIs. |

The ID is the first valid value from the correlation header, the request-ID header, or Hono's `requestId()` middleware variable; otherwise a fresh UUID. Valid means 1 to 128 characters of `[A-Za-z0-9._:-]`. The rest of the request runs inside `runWithCorrelationId()`, so every workflow call carries it into workflows and activities, and `getCorrelationId()` (re-exported from `@norn/hono`) works anywhere in the handler.

## `nornErrorHandler()`

```ts
app.onError(
  nornErrorHandler({
    status: { WORKFLOW_CLOSED: 410 },
    onError: (err, c) => logger.error({ err, correlationId: c.var.correlationId }),
  }),
);
```

Error responses look like this, with the correlation ID in the body and the response header:

```json
{ "error": { "code": "WORKFLOW_ALREADY_STARTED", "message": "Workflow payment-p1 is already running", "details": { "workflowId": "payment-p1", "workflowType": "PaymentWorkflow" }, "correlationId": "4f6c2a..." } }
```

- `NornError`s (from Norn, or your own `new NornError('CODE', status, message)`) use their status, or the override in `status`.
- Raw Temporal client errors are converted with `toNornError()` first, so a gRPC `UNAVAILABLE` still becomes `503 TEMPORAL_UNAVAILABLE`.
- Hono `HTTPException`s get the same JSON body, with a code derived from the status (`400` → `BAD_REQUEST`, `401` → `UNAUTHORIZED`, `404` → `NOT_FOUND`, otherwise `HTTP_<status>`) and the exception's message. An `HTTPException` created with its own `res` is sent as that response.
- Anything else becomes `500 INTERNAL` with the message `Internal Server Error`.

| Option | Description |
| --- | --- |
| `status` | HTTP status per error code, such as `{ WORKFLOW_CLOSED: 410, UPDATE_REJECTED: 409 }`. Must be 400 to 599. |
| `expose` | Return the message of unexpected errors instead of `Internal Server Error`. A boolean or `(err) => boolean`. Default `false`; never enable it unconditionally in production. |
| `onError` | Called with every error before responding, for logging or error tracking. Default: `console.error` for 500 `INTERNAL` errors. |
| `format` | Build the response yourself from the normalised `NornError`, the status, the correlation ID and the default body. |
| `correlationHeader` | Response header for the correlation ID when the request didn't go through `temporal()`. Default `x-correlation-id`. |

`errorBody(err, correlationId)` builds the standard body, if you respond with errors yourself.

## Webhooks: `temporalWebhook()`

Payment providers, carriers and e-signature services report progress through webhooks. `temporalWebhook()` turns each event into signals or updates on your workflows, with signature verification and the response codes providers expect:

```ts
import { hmacSha256Verifier, signalAction, temporalWebhook, updateAction } from '@norn/hono';

app.post(
  '/webhooks/transfers',
  temporalWebhook({
    verify: hmacSha256Verifier({ secret: env.TRANSFER_WEBHOOK_SECRET, header: 'x-signature', encoding: 'hex' }),
    map: (event: TransferWebhook) => {
      const paymentId = event.data.metadata?.paymentId;
      // not ours: 202 { accepted: 0, ignored: 'unmapped' }
      if (!paymentId) return null;
      return signalAction(PaymentWorkflow, { paymentId }, 'transferEvent', {
        eventId: event.eventId,
        type: event.type,
        returnCode: event.data.returnCode,
      });
    },
  }),
);
```

For each request it:

1. Reads the raw body once (over `maxBodyBytes`, default 1 MiB: **413** `WEBHOOK_TOO_LARGE`) and calls `verify(c, rawBody, rawBytes)`. Returning `false` responds **401** `WEBHOOK_UNVERIFIED`. `verify` is required; pass `verify: false` only when something in front of the endpoint already verifies requests.
2. Parses it (`JSON.parse`, or your `parse(rawBody, c)`). A parse error responds **400** `WEBHOOK_INVALID_BODY`.
3. Calls `map(body, c)`, which returns an action, a list of actions, or `null` / `undefined` / `[]` to ignore the event (**202** `{ accepted: 0, ignored: 'unmapped' }`). Every action is validated before any is sent, so a bad mapping never half-applies an event.
4. Sends the actions in order and responds **202** `{ accepted: n }`, plus `ignored: m` if some were skipped and `results` when there were updates.

Build actions with `signalAction(contract, target, signal, ...args)` and `updateAction(contract, target, update, ...args)`; both are typed by the contract, and `target` is the ID template's fields or `{ workflowId }`. Combine them with [`dedupeBy`](/guide/messages#dedupeby-at-least-once-sources) on the signal, because providers redeliver events.

What happens when the workflow isn't there:

| Option | Default | Behaviour |
| --- | --- | --- |
| `onClosed` | `'ignore'` | The workflow already closed: skip the action. If nothing was accepted, respond **200** `{ ignored: 'closed' }`, so the provider stops retrying a late delivery. |
| `onNotFound` | `'error'` | No such workflow: throw the error to `app.onError`, which `nornErrorHandler()` turns into **404** `WORKFLOW_NOT_FOUND` (or your status override). With `'ignore'`, skip the action (**200** `{ ignored: 'not_found' }` if nothing was accepted). |

Each takes `'ignore'`, `'error'`, or a function `({ action, index, error }, c)` that returns a `Response` to send, or nothing to ignore the action. Any other failure, such as Temporal being unavailable, is thrown to `app.onError`, so the response is a 5xx and the provider retries.

`temporalWebhook()` uses `c.var.norn` from the middleware; pass `client` to use another.

### `hmacSha256Verifier()`

Checks an HMAC-SHA256 signature of the raw body sent in a header, using WebCrypto and a constant-time comparison:

| Option | Description |
| --- | --- |
| `secret` | The shared webhook secret (UTF-8 string or bytes). |
| `header` | The header carrying the signature, such as `x-hub-signature-256`. |
| `encoding` | `'hex'` (default, either case) or `'base64'` (standard or URL-safe, padding optional). |
| `prefix` | A prefix the header value must start with, such as `'sha256='` (GitHub). |

Providers that sign something other than the raw body (a timestamp plus the body, or with another hash) need their own `verify` function; `hmacSha256()` and `timingSafeEqual()` are exported to help write one:

```ts
import { hmacSha256, timingSafeEqual } from '@norn/hono';

const verify = async (c: Context, rawBody: string) => {
  const timestamp = c.req.header('x-timestamp') ?? '';
  // replay window
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = await hmacSha256(env.SECRET, `${timestamp}.${rawBody}`);
  const given = Uint8Array.from(Buffer.from(c.req.header('x-signature') ?? '', 'hex'));
  return timingSafeEqual(expected, given);
};
```

## Codec server {#codec-server}

`codecServer(options)` returns a Hono app implementing the Temporal codec server protocol (`POST /encode`, `POST /decode`), so the Temporal UI and CLI can display encrypted payloads. Mount it under any path:

```ts
import { codecServer } from '@norn/hono/codec-server';

app.route('/codec', codecServer({ codec: createEncryptionCodec({ keys, currentKeyId }), auth: requireStaff }));
```

| Option | Default | Description |
| --- | --- | --- |
| `codec` | required | A `PayloadCodec`, or several in the order your data converter applies them. |
| `auth` | required | `(c) => boolean`; returning `false` or throwing responds 401. Anyone who passes can decrypt your payloads. `false` disables it, for servers already behind authentication. |
| `cors` | `{ origins: ['https://cloud.temporal.io', 'http://localhost:8233'] }` | Browser origins allowed to call it (`'*'` for any, without credentials), or `false` to disable CORS handling for CLI-only use. Other origins get 403. |
| `maxBodyBytes` | 16 MiB | Larger bodies get 413 `PAYLOAD_TOO_LARGE`. |
| `namespaces` | any | Namespaces (from the `X-Namespace` header) the server may be used for; others get 403. |
| `onError` | none | Called with errors from `auth` and the codecs, for logging. Payload contents are never passed to it. |

`@norn/hono/codec-server` depends only on Hono and `@norn/core`, so it can run on edge runtimes. See [Encryption](/guide/encryption#codec-server-for-the-temporal-ui) for pointing the UI at it.

## Testing routes

Pass a [fake client](/guide/testing#api-tests-createfakeclient) to the middleware and use Hono's `app.request()`:

```ts
const fake = createFakeClient();
const app = new Hono<NornEnv>().use(temporal({ client: fake }));
// ...register routes, app.onError(nornErrorHandler())
const res = await app.request('/payments', { method: 'POST', body: JSON.stringify({ paymentId: 'p1', amountCents: 100 }) });
expect(res.status).toBe(201);
expect(res.headers.get('x-correlation-id')).toBeTruthy();
```
