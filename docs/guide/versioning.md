# Versioning & safe deploys

A deploy is the moment Temporal's model bites: executions that started on the old code are still running, and when a worker on the new code picks up their next task it **replays their history** through the new code. If the new code would make different decisions (schedule a different activity, start a timer the old code didn't, skip a child workflow), the replay fails with a non-determinism error and the execution is stuck until you fix it.

Norn gives you four layers of protection:

1. **`norn.lock.json`** stops you from renaming or removing anything running executions depend on.
2. **Worker versioning** lets executions stay on the code they started with (`pinned`), or move to new code deliberately (`auto-upgrade`).
3. **Patching** with the SDK's `patched()` makes a change replay-safe for running executions.
4. **Replay tests** in CI run recorded production histories through the new code before it ships.

## What is and isn't a breaking change

Activity **implementations** never replay; change them freely. Workflow code changes break replay only if they change the **sequence of commands** an existing execution would produce:

| Safe | Breaking for running executions |
| --- | --- |
| Changing an activity's implementation, a service, a provider | Adding, removing or reordering activity calls, timers or child workflows on paths existing executions will take |
| Adding a new signal, query or update handler | Renaming or removing a handler, workflow type or activity (blocked by `norn.lock.json`) |
| Changing what a query returns | Moving a workflow to another task queue (blocked by `norn.lock.json`) |
| Changing code after the last command an execution will reach | Changing a `condition()` timeout or a `sleep()` duration that has already been scheduled |
| Changing activity options such as timeouts and retries | Changing branching logic so a replayed execution takes a different path |

## Rename protection: `norn.lock.json`

`norn gen` records every workflow type (with its task queue), signal, query, update and activity name in `norn.lock.json`. If a name disappears, generation fails:

```text
norn.lock.json - error norn(lock-removed): signal "pause" of OrderWorkflow was removed or renamed; in-flight executions (and callers) still send "pause", which would be rejected or dropped
  hint: If this is intentional (no executions in flight, or they were migrated), run norn gen --accept-rename to update norn.lock.json.
```

Adding names never complains. When a removal is intentional (you've drained or migrated every execution that could use the old name), run `norn gen --accept-rename` and commit the updated lock. To rename a handler's method without changing its wire name, keep the old name in the decorator: `@Signal('pause') suspend()`.

## Worker versioning

With [worker versioning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning), each worker process declares a **deployment name** and a **build ID**. The server routes each workflow execution's tasks to a specific version:

- **`pinned`**: an execution runs on the build it started on until it completes. New code never replays old executions, so you can change anything. The cost: old workers must stay up until their pinned executions finish.
- **`auto-upgrade`**: an execution moves to the current version at its next workflow task. It always runs the newest code, so changes must be replay-safe (patching).

Enable it by setting both variables on the worker:

```sh
NORN_DEPLOYMENT_NAME=orders
NORN_BUILD_ID=$GIT_SHA
```

and choose the behavior per workflow:

```ts
@Workflow({ taskQueue: 'payments', id: 'payment-{paymentId}', versioning: 'pinned' })
export class PaymentWorkflow { /* days long: easiest to keep on its original code */ }

@Workflow({ taskQueue: 'loyalty', id: 'loyalty-{customerId}', versioning: 'auto-upgrade' })
export class LoyaltyWorkflow { /* lives forever: must upgrade, so changes are patched */ }
```

Workflows without `versioning` use the worker's default, `'auto-upgrade'` unless you pass `versioning: { deploymentName, buildId, defaultBehavior: 'pinned' }` to `createWorker()`.

**Rule of thumb:** pin workflows that finish in hours or days; auto-upgrade workflows that live for weeks or forever (entity workflows), and use continue-as-new so each run is short-lived anyway.

### Rolling out a version

1. Deploy workers with the new `NORN_BUILD_ID` **alongside** the current ones. They register their version with the deployment but receive no new work yet.
2. Make the new version current, for example with the Temporal CLI:

   ```sh
   temporal worker deployment set-current-version --deployment-name orders --build-id "$GIT_SHA"
   ```

   or ramp gradually with `set-ramping-version`. New executions (and auto-upgrade executions) now go to the new version.
3. Keep the old version's workers running until its pinned executions have drained (`temporal worker deployment describe-version` shows whether it is still in use), then scale them down.

On ECS or Kubernetes this means running each version as its own service or deployment, named after the build ID, rather than updating one service in place.

## Patching

For changes to workflows that will replay on new code (auto-upgrade, or unversioned workers), wrap the new behavior in `patched()` from `@temporalio/workflow`:

```ts
import { patched } from '@temporalio/workflow';

async run(input: OrderInput) {
  const charge = await this.payments.charge(input.orderId, input.cents);
  if (patched('send-receipt-v1')) {
    // New executions (and replays that reach this point for the first time) send a receipt.
    await this.notify.email(input.email, 'receipt', { chargeId: charge.id });
  }
  // ...
}
```

`patched()` returns `true` for executions that first reach it on new code and `false` when replaying history recorded before the patch existed, so both kinds replay correctly. Once no execution started before the patch is still running, replace it with `deprecatePatch('send-receipt-v1')` and remove the old branch; after those executions are gone too, remove the call. Norn doesn't wrap patching; see the [Temporal docs on patching](https://docs.temporal.io/develop/typescript/versioning).

## Replay tests {#replay-tests}

The most reliable check is to replay real histories through the new code. Record some executions of each workflow type, commit them, and replay them in CI:

```sh
norn histories pull order-o-42 payment-p_9 --out test/histories   # one <workflowId>.json per execution (latest run)
```

`--out` defaults to `histories`. The namespace and server come from `TEMPORAL_NAMESPACE` and `TEMPORAL_ADDRESS`, as for [the other CLI commands](/guide/cli#norn-histories-pull).

You can also download a history from the Temporal UI or with `temporal workflow show --workflow-id order-o-42 --output json > test/histories/order-o-42.json`; `loadHistories()` reads both formats.

```ts
// test/replay.test.ts
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { assertReplays, loadHistories } from '@norn-ts/testing';
import { registry } from '../.norn/registry.js';

it('replays recorded production histories', async () => {
  const histories = await loadHistories(fileURLToPath(new URL('./histories', import.meta.url)));
  await assertReplays(histories, { registry });
}, 120_000);
```

`assertReplays()` bundles the current workflows, replays every history, and throws one error listing every execution that would hit a non-determinism error:

```text
Error: 1 of 12 histories failed to replay:
- order-o-42: [TMPRL1100] Nondeterminism error: Activity type of scheduled event 'payments.charge' does not match activity type of activity command 'payments.authorize'
```

Pick histories that cover each workflow's main paths, including long-running executions that are mid-way through. If payloads are encrypted, pass the same `dataConverter` the workers use: `assertReplays(histories, { registry, dataConverter: createDataConverter({ keys, currentKeyId }) })`.

## A deploy checklist

- `norn gen --check` passes, and any `--accept-rename` in the diff is deliberate.
- Replay tests pass against recent production histories.
- Breaking changes to auto-upgrade workflows are behind `patched()`.
- Pinned workflows: the old version keeps running until drained.
- Schedules: run `norn schedules sync` after the new workers are up.
