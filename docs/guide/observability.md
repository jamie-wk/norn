# Observability

A Temporal application has three places to look when something goes wrong: the **Temporal UI** (what each execution did, step by step), **logs and traces** from your API and workers, and **metrics** about the workers themselves. Norn connects them with correlation IDs, exposes Prometheus metrics with one call, and passes Temporal's OpenTelemetry plugin straight through.

## Correlation IDs

A correlation ID is a string that follows one logical request everywhere it goes. Norn carries it in a Temporal header named `norn-correlation-id`:

```text
HTTP request (x-correlation-id: req-7)
  → client.start / signal / update / query  (header set from the current context)
    → workflow                               (header remembered by Norn's workflow interceptor)
      → activities, local activities         (header forwarded; activity runs with getCorrelationId() = 'req-7')
      → child workflows, signals to others   (forwarded)
      → continue-as-new                      (forwarded to the next run)
        → activity calls the client again    (same ID, onwards)
```

### On the API side

`runWithCorrelationId(id, fn)` from `@norn-ts/client` sets the ID for everything inside `fn`, using `AsyncLocalStorage`, and the client adds it to every outbound start, signal, signal-with-start, query, update and update-with-start:

```ts
import { getCorrelationId, runWithCorrelationId } from '@norn-ts/client';

app.use(async (req, res, next) => {
  const id = (req.headers['x-correlation-id'] as string | undefined) ?? crypto.randomUUID();
  res.setHeader('x-correlation-id', id);
  runWithCorrelationId(id, next);
});
```

With Hono, the [`temporal()` middleware](/guide/hono#correlation-ids) does this for you: it takes the ID from `x-correlation-id`, then `x-request-id`, then Hono's `requestId()` middleware, validates it (1 to 128 characters of `[A-Za-z0-9._:-]`), falls back to a fresh UUID, echoes it in the response, and puts it on `c.var.correlationId`. Set `trustIncoming: false` on public APIs so callers can't choose the IDs that end up in your logs.

You can also pass `correlationId` per call in the start options. Turn the client-side header off with `createClient({ correlation: false })`.

### On the worker side

`createWorker()` installs Norn's workflow interceptors (bundled into the workflow sandbox) and an activity interceptor. Inside an activity, and anything it calls, `getCorrelationId()` from `@norn-ts/activity` returns the ID:

```ts
import { getCorrelationId } from '@norn-ts/activity';

@Service()
export class HttpClient {
  async post<T>(path: string, body: unknown): Promise<T> {
    const correlationId = getCorrelationId();
    const res = await fetch(new URL(path, this.config.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
      body: JSON.stringify(body),
    });
    // ...
  }
}
```

Add it to your logger so every log line from an activity can be joined with the API request that caused it:

```ts
import pino from 'pino';
import { activityInfo, getCorrelationId } from '@norn-ts/activity';

export const RequestLog = token<pino.Logger>('RequestLog');
provide(RequestLog, () => root.child({ correlationId: getCorrelationId(), activity: activityInfo().activityType, workflowId: activityInfo().workflowExecution?.workflowId }), { scope: 'activity' });
```

Because `@norn-ts/client` and `@norn-ts/activity` share one `AsyncLocalStorage` through a global symbol, a client call made from inside an activity carries the same ID onward, even if the packages are installed as separate copies.

## Metrics

Call `installRuntime()` once at worker startup, before creating the worker:

```ts
import { createWorker, installRuntime } from '@norn-ts/worker';

// or NORN_METRICS_ADDRESS
installRuntime({ metricsAddress: '0.0.0.0:9464' });
const worker = await createWorker({ registry });
```

Prometheus metrics for the SDK and Temporal core are then served at `http://<host>:9464/metrics`. Scrape them like any other target. The metrics that matter most at first:

- **Workflow and activity task schedule-to-start latency**: how long tasks wait for a worker. Rising latency means you need more workers (or more concurrency per worker).
- **Activity execution failures** by activity type: a failing dependency.
- **Workflow task failures**: non-determinism or bugs in workflow code; these leave executions stuck until fixed.
- **Sticky cache hits and misses**: whether workers are sized to keep their workflows cached.

`installRuntime()` also sets the SDK's log level from `logLevel` or `NORN_LOG_LEVEL` (default `INFO`). It throws if called twice, or after a connection or worker was created, because the Temporal runtime is process-wide.

The health server's `/readyz` (see [Worker & deployment](/guide/worker#health-checks)) reports each task queue's worker state, which is useful for uptime checks.

## OpenTelemetry

Temporal's [`@temporalio/interceptors-opentelemetry`](https://github.com/temporalio/sdk-typescript/tree/main/packages/interceptors-opentelemetry) package creates spans for workflow starts, signals, queries, workflow executions and activities, and propagates trace context through Temporal headers. Norn doesn't wrap it; pass its plugin through `plugins`, and its client interceptor through `interceptors`.

```ts
// worker
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { createWorker } from '@norn-ts/worker';
import { registry } from '../.norn/registry.js';

const otel = new OpenTelemetryPlugin({
  resource: resourceFromAttributes({ 'service.name': 'orders-worker' }),
  spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
});

const worker = await createWorker({
  registry,
  plugins: [otel],
});
```

```ts
// client
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry';

const norn = createClient({ interceptors: [new OpenTelemetryWorkflowClientInterceptor()] });
```

::: warning Prebuilt bundles and plugins
Temporal plugins that add workflow interceptors can only add them when the bundle is built. `createWorker()` passes `plugins` to its own bundling at startup; when you prebuild for production, use `bundleWorkflows(registry, { plugins: [otel] })`. `norn bundle` has no option for plugins.
:::

Correlation IDs and trace IDs complement each other: traces show timing within one request, and the correlation ID survives places traces often don't, like an activity that runs three days later after a timer.

## The Temporal UI

- Use **ID templates** that contain your business keys (`payment-{paymentId}`), so the UI is searchable by the IDs your support team already has.
- Set **search attributes** for the fields you filter by (`CustomerId`, `PaymentStatus`), and update them as state changes.
- **JSDoc comments** on handlers become descriptions, and `@Activity({ summary })` and the `summary` / `details` start options label executions in the UI.
- With encryption, run a [codec server](/guide/encryption#codec-server-for-the-temporal-ui) so operators can read payloads.
