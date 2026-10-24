---
title: "Worker & deployment"
description: createWorker(), connection settings, task queues, graceful shutdown, production builds and a Dockerfile.
---

`createWorker()` runs your workflows and activities: one Temporal worker per task queue, a workflow bundle built at startup or ahead of time, and graceful shutdown on SIGTERM.

```ts
// src/worker.ts
import { createWorker } from '@norn-ts/norn/worker';
import { PaymentActivities } from './activities/payment.activities';
import { StripeGateway } from './services/stripe';

const worker = await createWorker({
  workflows: new URL('./workflows/index.ts', import.meta.url),
  activities: { payments: new PaymentActivities(new StripeGateway(process.env.STRIPE_KEY!)) },
});
await worker.run(); // resolves after a graceful shutdown; rejects if a worker fails
```

- **`workflows`** is the module that exports your `@Workflow` classes. The worker imports it once to learn their task queues, then bundles it for the workflow sandbox.
- **`activities`** maps a namespace to an object. Every method of `activities.payments` is registered as `payments.<method>`, the names `useActivities<PaymentActivities>('payments')` schedules. Build your dependencies here, with plain constructors.

## Connection settings

| Variable | Option | Default | Description |
| --- | --- | --- | --- |
| `TEMPORAL_ADDRESS` | `address` | `localhost:7233` | Temporal frontend address (`host:port`). |
| `TEMPORAL_NAMESPACE` | `namespace` | `default` | Namespace to poll. |
| `TEMPORAL_API_KEY` | `apiKey` | none | API key (Temporal Cloud). Turns TLS on. |
| `TEMPORAL_TLS` | `tls` | `false` | `true` turns TLS on without an API key. |
| `NORN_WORKFLOW_BUNDLE` | `workflowBundle` | bundle at startup | Path of a [prebuilt workflow bundle](#prebuilt-workflow-bundle). Ignored by an activity-only worker. |

Options win over environment variables, and empty variables count as unset. For mTLS client certificates, connect yourself and pass the connection:

```ts
import { readFile } from 'node:fs/promises';
import { NativeConnection } from '@temporalio/worker';

const connection = await NativeConnection.connect({
  address: process.env.TEMPORAL_ADDRESS!,
  tls: { clientCertPair: { crt: await readFile('/certs/client.pem'), key: await readFile('/certs/client.key') } },
});
const worker = await createWorker({ workflows, activities, connection });
// Norn doesn't close connections it didn't open.
```

## `createWorker()` options

| Option | Description |
| --- | --- |
| `workflows` | The module exporting your `@Workflow` classes, as a URL or path. |
| `activities` | Activity objects by namespace. |
| `taskQueues` | Queues to poll. Defaults to every queue the workflows declare; required for an activity-only worker. |
| `address`, `namespace`, `apiKey`, `tls` | Connection settings, as above. |
| `connection` | An existing `NativeConnection`. |
| `workflowBundle` | `{ code }` or `{ codePath }` from `bundleWorkflows()`. |
| `dataConverter` | A custom data converter, such as one that encrypts payloads. |
| `plugins` | Temporal worker plugins, such as OpenTelemetry. Also applied when bundling. |
| `shutdownGraceTime` | How long in-flight activities may run after shutdown starts. Default `30s`. |
| `handleSignals` | Shut down gracefully on SIGTERM and SIGINT. Default `true`. |
| `workerOptions` | Passed through to every `Worker.create()`: concurrency limits, pollers, interceptors, `workerDeploymentOptions` for worker versioning, and so on. |

## Lifecycle and graceful shutdown

`createWorker()` resolves once the connection is open, the bundle is loaded and every Temporal worker is created. Its `state` is then `INITIALIZED`. `run()` starts polling (`RUNNING`) and resolves when the worker has stopped. On **SIGTERM** or **SIGINT**, or when you call `shutdown()`:

1. The state becomes `STOPPING`, and every Temporal worker stops polling.
2. In-flight workflow tasks finish. In-flight activities get up to `shutdownGraceTime` to complete, after which they're cancelled (activities that heartbeat see the cancellation).
3. Norn closes the connection it opened. `run()` resolves, the state is `STOPPED`, and your process exits normally.

If one task queue's worker fails, Norn stops the others and `run()` rejects (state `FAILED`), so the process exits and your orchestrator restarts it. `await using worker = await createWorker(...)` shuts down when the scope ends.

Give your platform at least the grace time plus a margin to stop the container (`stopTimeout` on ECS, `terminationGracePeriodSeconds` on Kubernetes). If it kills the process first, in-flight activities are retried elsewhere after their timeouts, which is safe because activities must be idempotent, but slow.

## Scaling task queues

By default one process polls every task queue your workflows declare. To scale queues independently, run the same code with different `taskQueues`, for example from an environment variable:

```ts
const worker = await createWorker({
  workflows,
  activities,
  taskQueues: process.env.TASK_QUEUES?.split(','),
});
```

## Production

In development, `tsx` runs your TypeScript and the worker bundles the workflows at startup. In production, compile first. The starter's `pnpm build` compiles the worker and the workflows module with esbuild, and `pnpm start` runs it:

```sh
esbuild src/worker.ts src/workflows/index.ts --bundle --platform=node --target=node22 --format=esm --packages=external --outdir=dist
node dist/worker.js
```

`--target=node22` matters: it lowers the decorators, which Node can't run yet. The compiled worker still names `./workflows/index.ts`; when that file doesn't exist, Norn loads the compiled `dist/workflows/index.js` next to it.

### Prebuilt workflow bundle

Bundling at startup takes a few seconds and needs webpack at runtime. To skip it, build the bundle once at build time and point `NORN_WORKFLOW_BUNDLE` at it:

```ts
// scripts/bundle.ts, run with tsx
import { bundleWorkflows } from '@norn-ts/norn/worker';

await bundleWorkflows(new URL('../src/workflows/index.ts', import.meta.url), { outFile: 'dist/workflow-bundle.js' });
```

```sh
NORN_WORKFLOW_BUNDLE=dist/workflow-bundle.js node dist/worker.js
```

With a prebuilt bundle the worker writes nothing to disk, so it runs on a read-only filesystem. Bundling at startup writes a small entry file to the OS temp directory.

### Dockerfile

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build && pnpm exec tsx scripts/bundle.ts && pnpm prune --prod

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production NORN_WORKFLOW_BUNDLE=/app/dist/workflow-bundle.js
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
# Exec form, so node is PID 1 and receives SIGTERM directly.
CMD ["node", "dist/worker.js"]
```

Use a Debian-based image such as `node:24-slim`, because the Temporal SDK includes a native module built for glibc. `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` and `TEMPORAL_API_KEY` come from your deployment.

## Metrics, logs and health

Norn leaves these to the Temporal SDK. Install the SDK runtime before creating the worker:

```ts
import { Runtime } from '@temporalio/worker';

Runtime.install({
  telemetryOptions: { metrics: { prometheus: { bindAddress: '0.0.0.0:9464' } } },
});
```

For a liveness check, watch the process. A failed worker makes `run()` reject and the process exit, and `worker.state` is there if you serve your own health endpoint.
