---
title: 5. Build for production
description: Compile the project, bundle the workflows ahead of time, and run the worker and API from the build against any Temporal server.
sidebar:
  order: 5
---

In development, `pnpm dev` runs TypeScript directly and bundles the workflows each time the worker starts. In production you want a build: plain JavaScript, a workflow bundle made once at build time, and processes that start fast.

## Configure the build

During development, `tsx` and Vitest run your TypeScript and resolve extensionless imports such as `'../.norn/registry'`. For production, [esbuild](https://esbuild.github.io) does the same job ahead of time: it compiles the worker and the API into one JavaScript file each, lowering the decorators along the way.

```sh
pnpm add -D esbuild
```

Add three scripts to `package.json`:

```json
"build": "norn gen --check && tsc --noEmit && norn bundle --out dist/workflow-bundle.js && esbuild src/worker.ts src/server.ts --bundle --platform=node --target=node22 --format=esm --packages=external --outdir=dist",
"start": "NORN_WORKFLOW_BUNDLE=dist/workflow-bundle.js node dist/worker.js",
"start:api": "node dist/server.js"
```

- **`norn gen --check`** fails if `.norn/` is out of date with the source, instead of silently regenerating it. Run it in CI too.
- **`tsc --noEmit`** type-checks. esbuild strips types without checking them, so this is what stops a type error from shipping.
- **`norn bundle`** builds the workflow bundle once, at build time. It holds the code the worker runs in the sandbox. The worker loads it from `NORN_WORKFLOW_BUNDLE` instead of bundling at startup. Always set that variable for a built worker.
- **esbuild** bundles your own code into `dist/worker.js` and `dist/server.js`. `--packages=external` leaves dependencies in `node_modules`, where Node loads them as usual, and `--target=node22` makes it lower the decorators, which Node can't run yet.

```sh
pnpm build
```

```text
Generated files are up to date.
...
wrote dist/workflow-bundle.js (1880 KiB) from .norn/workflows.ts

  dist/worker.js  3.7kb
  dist/server.js  1.6kb
```

## Run the build

The worker and the API read the Temporal connection from the environment:

| Variable | Default | |
| --- | --- | --- |
| `TEMPORAL_ADDRESS` | `localhost:7233` | The Temporal frontend, such as `my-ns.a1b2c.tmprl.cloud:7233` |
| `TEMPORAL_NAMESPACE` | `default` | |
| `TEMPORAL_API_KEY` | none | A Temporal Cloud API key. Setting it turns on TLS. |

Run them against your local dev server to check the build:

```sh
pnpm start       # the worker
pnpm start:api   # the API, in another terminal
```

Start an order through the API as in [chapter 3](/norn/tutorial/3-http-api/). The worker's log shows the charge and the receipt, from the compiled code and the prebuilt bundle.

The worker and the API are separate processes, and they scale separately. Run as many workers as the load needs: Temporal spreads the work across them through the `orders` task queue. Nothing about a workflow lives in a worker's memory between steps, so you can stop, restart and redeploy workers at any time. That's what you did by hand in the quickstart.

## Ready for production

The worker already does the things a production worker needs:

- On **SIGTERM** it stops taking new work and lets in-flight activities finish, for up to `NORN_SHUTDOWN_GRACE` (30 seconds by default), which makes rolling deploys safe.
- With `NORN_HEALTH_PORT` set, it serves **liveness and readiness** endpoints for your orchestrator.
- `NORN_METRICS_ADDRESS` exposes **Prometheus metrics** from the Temporal runtime.

[Worker & deployment](/norn/guides/worker/) covers these, along with a Dockerfile, task queue strategy and every environment variable. Before you deploy for real, read:

- [Versioning & safe deploys](/norn/guides/versioning/): worker versioning, and a deploy checklist.
- [Encryption & codec server](/norn/guides/encryption/), if workflow inputs contain personal data. Temporal stores every payload in its history.
- [Observability](/norn/guides/observability/): correlation IDs, metrics and tracing.

## What you built

Over five chapters, the starter's order workflow has become a small service:

- A workflow that charges, waits, ships and compensates, and survives crashes at every step.
- Two activity classes with injected services, retries, and errors that shouldn't be retried.
- An update guarded by a validator, and a typed HTTP API with errors mapped to status codes.
- Workflow tests that skip time, API tests without a server, and replay tests against recorded histories.
- A production build.

From here, the [guides](/norn/guides/workflows/) go deeper into each topic: [child workflows](/norn/guides/child-workflows/), [schedules](/norn/guides/schedules/), [long-running workflows](/norn/guides/long-running/), [webhooks](/norn/guides/hono/#webhooks-temporalwebhook) and more. The [recipes](/norn/recipes/) show complete designs for real problems.
