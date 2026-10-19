# Worker & deployment

`createWorker()` from `@norn/worker` turns the generated registry into a production worker process: one Temporal worker per task queue, activities built by the dependency container, a prebuilt or on-the-fly workflow bundle, health endpoints, graceful shutdown on SIGTERM, correlation IDs and optional worker versioning.

```ts
// src/worker.ts
import { createWorker, installRuntime } from '@norn/worker';
import { registry } from '../.norn/registry.js';

installRuntime(); // log level and Prometheus metrics from the environment; optional

const worker = await createWorker({
  registry,
  container: { errors: { http: true } }, // 4xx from providers are final, 5xx retried
});
await worker.run(); // resolves after a graceful shutdown; rejects if a worker fails
```

Everything else is configured through options or environment variables, so the same image runs in every environment.

## Environment variables

| Variable | Option | Default | Description |
| --- | --- | --- | --- |
| `TEMPORAL_ADDRESS` | `address` | `localhost:7233` | Temporal frontend address (`host:port`). |
| `TEMPORAL_NAMESPACE` | `namespace` | `default` | Namespace to poll. |
| `TEMPORAL_API_KEY` | `apiKey` | none | API key (Temporal Cloud). Turns TLS on. |
| `NORN_TASK_QUEUES` | `taskQueues` | every queue in the registry | Comma-separated subset of task queues to poll, such as `orders,shipping`. |
| `NORN_HEALTH_PORT` | `health.port` | off | Port for the [health server](#health-checks). `0` picks a free port. |
| `NORN_SHUTDOWN_GRACE` | `shutdownGraceTime` | `30s` | How long in-flight activities may run after shutdown starts. Any `Duration`: `60s`, `2m`, `PT90S`. |
| `NORN_DEPLOYMENT_NAME` | `versioning.deploymentName` | none | Worker deployment name. Set with `NORN_BUILD_ID` to enable [worker versioning](/guide/versioning). |
| `NORN_BUILD_ID` | `versioning.buildId` | none | Build ID of this worker version, such as the git SHA. |
| `NORN_WORKFLOW_BUNDLE` | `workflowBundle` | bundle at startup | Path of a prebuilt workflow bundle from `norn bundle` / `bundleWorkflows()`. |
| `NORN_METRICS_ADDRESS` | `installRuntime({ metricsAddress })` | off | `host:port` for the Prometheus endpoint, such as `0.0.0.0:9464`. |
| `NORN_LOG_LEVEL` | `installRuntime({ logLevel })` | `INFO` | `TRACE`, `DEBUG`, `INFO`, `WARN` or `ERROR`. |

Options passed to `createWorker()` win over environment variables. Setting only one of `NORN_DEPLOYMENT_NAME` and `NORN_BUILD_ID` is a startup error, as are malformed ports and durations: a misconfigured worker fails at boot with a `NornConfigError`, not later. `NORN_DEV_CONDITIONS` (comma-separated export conditions for the workflow bundler) is useful in monorepos that resolve workspace packages to source.

## `createWorker()` options

| Option | Description |
| --- | --- |
| `registry` | **Required.** The generated `registry` from `.norn/registry.ts`. |
| `taskQueues` | Subset of the registry's task queues to poll. |
| `allowUnknownTaskQueues` | Allow queues no workflow declares, for activity-only workers. |
| `address`, `namespace`, `apiKey`, `tls` | Connection settings. `tls` is a boolean; for mTLS pass your own `connection`. |
| `connection` | An existing `NativeConnection`. Norn doesn't close connections it didn't open. |
| `versioning` | `{ deploymentName, buildId, defaultBehavior? }`, or `false` to ignore the environment. |
| `health` | `{ port, host? }` or `false`. Host defaults to `0.0.0.0`. |
| `shutdownGraceTime` | A `Duration`. |
| `handleSignals` | Shut down gracefully on SIGTERM and SIGINT. Default `true`. |
| `container` | `{ overrides, errors }` for the dependency container. See [Errors](/guide/errors#activity-errors). |
| `workflowBundle` | `{ code }` or `{ codePath }` from `bundleWorkflows()`. |
| `dataConverter` | Such as `createDataConverter()` from [`@norn/codec`](/guide/encryption). |
| `plugins` | Temporal worker plugins, such as the [OpenTelemetry plugin](/guide/observability#opentelemetry). |
| `activityInterceptors` | Extra activity interceptor factories, after Norn's correlation interceptor. |
| `activityOverrides` | Replace registered activities by name, typically in tests. Unknown names are rejected. |
| `extraActivities` | Register activities that aren't `@Activities` classes. |
| `workerOptions` | Passed through to every `Worker.create()`: concurrency limits, sticky cache size, pollers, workflow interceptors. Norn sets connection, namespace, task queue, activities, bundle, data converter, plugins, `shutdownGraceTime` and `workerDeploymentOptions` itself (use `createWorker()`'s own options for those). |

### mTLS with client certificates

```ts
import { readFile } from 'node:fs/promises';
import { NativeConnection } from '@temporalio/worker';

const connection = await NativeConnection.connect({
  address: process.env.TEMPORAL_ADDRESS!,
  tls: { clientCertPair: { crt: await readFile('/certs/client.pem'), key: await readFile('/certs/client.key') } },
});
const worker = await createWorker({ registry, connection });
// close `connection` yourself after worker.run() resolves
```

## Lifecycle and graceful shutdown

`createWorker()` resolves once everything is ready: activities and every singleton dependency are created (so a bad provider fails here), the connection is open, the bundle is loaded and the health server listens. The worker's `state` is then `INITIALIZED`.

`run()` starts polling every task queue (`RUNNING`) and resolves when the worker has stopped. On **SIGTERM** or **SIGINT**, or when you call `shutdown()`:

1. The state becomes `STOPPING` and `/readyz` starts returning 503.
2. Every Temporal worker stops polling. In-flight workflow tasks finish; in-flight activities get up to `shutdownGraceTime` to complete, after which they are cancelled (activities that heartbeat see the cancellation).
3. The dependency container disposes every singleton in reverse creation order, the health server closes, and Norn closes the connection it opened.
4. `run()` resolves and the state is `STOPPED`; your process exits normally.

If one task queue's worker fails, Norn stops the others and `run()` rejects (state `FAILED`), so the process exits and your orchestrator restarts it. `await using worker = await createWorker(...)` shuts down when the scope ends.

Give your platform at least the grace time plus a margin to stop the container: `stopTimeout` on ECS, `terminationGracePeriodSeconds` on Kubernetes. If it kills the process first, in-flight activities are retried elsewhere after their timeouts, which is safe (activities must be idempotent) but slow.

## Health checks

With `NORN_HEALTH_PORT` (or `health: { port }`), the worker serves:

| Endpoint | Status | Meaning |
| --- | --- | --- |
| `GET /healthz` | `200 {"status":"ok"}` | The process is alive. Use for liveness. |
| `GET /readyz` | `200 {"status":"ready","details":{...}}` or `503 {"status":"not ready",...}` | Every task queue's worker is polling. `details` maps each queue to its SDK worker state. 503 during startup and shutdown. |

`HEAD` works too; anything else is 404 or 405. Workers have no inbound traffic, so readiness is for monitoring and deploy gates rather than load balancing. A typical setup checks `/healthz` for liveness and alerts on `/readyz`.

```yaml
# Kubernetes
livenessProbe: { httpGet: { path: /healthz, port: 8080 }, periodSeconds: 10 }
readinessProbe: { httpGet: { path: /readyz, port: 8080 }, periodSeconds: 5 }
terminationGracePeriodSeconds: 90 # > NORN_SHUTDOWN_GRACE
```

## Choosing task queues {#choosing-task-queues}

By default one process polls every task queue in the registry, which is right for small and medium apps. To scale queues independently, deploy the same image several times with different `NORN_TASK_QUEUES`:

```text
orders-worker:    NORN_TASK_QUEUES=orders,payments
shipping-worker:  NORN_TASK_QUEUES=shipping
```

Every process registers all activities and the full workflow bundle; it simply polls fewer queues. Queues that no workflow declares (for example an activity `taskQueue: 'gpu'`) need `allowUnknownTaskQueues: true`, so a typo in `NORN_TASK_QUEUES` is still caught.

## Production builds: compile, then bundle

In development `createWorker()` bundles the workflows at startup from the `.ts` sources, which takes a few seconds and needs the bundler toolchain at runtime. In production, build the bundle once, at build time, and ship it:

```sh
norn gen --check                               # generated files are committed and current
tsc -p tsconfig.build.json                     # dist/src/**, dist/.norn/** (registry now points at workflows.js)
norn bundle --out dist/workflow-bundle.js      # the workflow bundle
NORN_WORKFLOW_BUNDLE=dist/workflow-bundle.js node dist/src/worker.js
```

`norn bundle` bundles the barrel in `outDir`: `.norn/workflows.ts`, or `workflows.js` only when there is no `.ts`, so it reads the sources rather than the `tsc` output. `--out` defaults to `dist/workflow-bundle.js`; add `--codec` if you use `@norn/codec`'s payload converter. See [the CLI page](/guide/cli#norn-bundle).

If you'd rather script it, `bundleWorkflows()` does the same thing:

```ts
// scripts/bundle.ts
import { bundleWorkflows } from '@norn/worker';
import { resolvePayloadConverterPath } from '@norn/codec'; // only if you use @norn/codec
import { registry } from '../dist/.norn/registry.js';

await bundleWorkflows(registry, {
  outFile: 'dist/workflow-bundle.js',
  payloadConverterPath: resolvePayloadConverterPath(),
});
```

Bundling uses Norn's webpack settings: TC39 standard decorators, `.js` specifiers resolving to `.ts` sources, and Norn's workflow interceptors (which forward correlation IDs). For custom bundling, `nornWebpackConfigHook()`, `composeWebpackHooks()` and `workflowInterceptorModule` are exported.

A prebuilt bundle is also a deploy artifact you can replay-test in CI against recorded histories before it ships; see [Versioning](/guide/versioning#replay-tests).

## Dockerfile

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm norn gen --check \
 && pnpm tsc -p tsconfig.build.json \
 && pnpm norn bundle --out dist/workflow-bundle.js \
 && pnpm prune --prod

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    NORN_WORKFLOW_BUNDLE=/app/dist/workflow-bundle.js \
    NORN_HEALTH_PORT=8080 \
    NORN_SHUTDOWN_GRACE=60s \
    NORN_METRICS_ADDRESS=0.0.0.0:9464
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080 9464
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Exec form, so node is PID 1 and receives SIGTERM directly.
CMD ["node", "dist/src/worker.js"]
```

Use a Debian-based image such as `node:24-slim`: the Temporal SDK includes a native module built for glibc. `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY` and, for versioning, `NORN_DEPLOYMENT_NAME` / `NORN_BUILD_ID` come from your deployment.

## Metrics and logs

`installRuntime()` installs the Temporal runtime once per process, **before** any connection or worker is created (calling it later throws). It sets the SDK log level (`NORN_LOG_LEVEL`) and, with `NORN_METRICS_ADDRESS`, serves Prometheus metrics for the SDK and Temporal core at `http://<address>/metrics`:

```ts
installRuntime({ metricsAddress: '0.0.0.0:9464', logLevel: 'INFO' }); // or from the environment
```

The metrics are the standard Temporal SDK metrics. The schedule-to-start latencies for workflow and activity tasks tell you whether you are short of workers; activity and workflow failure counters tell you whether something is broken. See [Observability](/guide/observability).

## Running workers in tests

`createTestEnv()` from `@norn/testing` runs `createWorker()` for you against a test server, with signals, health and versioning turned off. To run one yourself:

```ts
const worker = await createWorker({
  registry,
  connection: env.temporal.nativeConnection,
  namespace: env.temporal.namespace ?? 'default',
  handleSignals: false,
  workflowBundle: await bundleWorkflows(registry),
  activityOverrides: { 'payments.charge': async () => ({ id: 'ch_test', cents: 100 }) },
});
```
