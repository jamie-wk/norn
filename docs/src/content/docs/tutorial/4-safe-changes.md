---
title: 4. Change workflows safely
description: Record real workflow histories, replay them in a test, see a careless change break them, and fix it with a patch.
sidebar:
  order: 4
---

Workflows can run for minutes, days or months, and while they run, you deploy new code. When a worker picks up a workflow after a deploy, it **replays** the workflow's history through the new code to rebuild its state. If the new code makes different decisions from the ones recorded, for example by scheduling an activity the history doesn't have, Temporal can't reconcile the two and the workflow gets stuck with a **nondeterminism error**.

[Determinism & the sandbox](/norn/concepts/determinism/) explains why. This chapter shows how to catch the problem in a test, before you deploy.

## Record some histories

Make sure `pnpm dev` is running, and that you have at least one finished order and one that is still waiting out its window. The `o-100` order from the last chapter is finished. Start another:

```sh
pnpm order start o-200
```

Download both histories into the test folder with the `norn` CLI:

```sh
pnpm exec norn histories pull order-o-100 order-o-200 --out test/histories
```

```text
wrote test/histories/order-o-100.json
wrote test/histories/order-o-200.json
```

Commit them. In a real project, pull histories from production that cover each workflow's main paths, including ones that are partway through.

## Replay them in a test

```ts
// test/replay.test.ts
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { assertReplays, loadHistories } from '@norn-ts/testing';
import { registry } from '../.norn/registry';

it('replays recorded histories with the current code', async () => {
  const histories = await loadHistories(fileURLToPath(new URL('./histories', import.meta.url)));
  await assertReplays(histories, { registry });
}, 120_000);
```

`assertReplays()` bundles the current workflow code and replays every history through it, without a server. It passes now, because the code hasn't changed since the histories were recorded.

## Make a careless change

The business wants a receipt emailed right after payment. Add an activity to `PaymentActivities`:

```ts
@Activity({ timeout: '30s', retries: 5 })
async sendReceipt(orderId: string, cents: number) {
  console.log(`receipt for ${orderId}: ${cents} cents`);
}
```

Call it in the workflow, straight after the charge:

```ts ins={3}
const charge = await this.payments.charge(input.orderId, input.cents);
this.status = 'paid';
await this.payments.sendReceipt(input.orderId, input.cents);
```

Add `sendReceipt: async () => {}` to the payments mock in `test/order.workflow.test.ts` (the mock is typed, so the compiler reminds you), and run the replay test:

```sh
pnpm test
```

```text
Error: 2 of 2 histories failed to replay:
- order-o-100: Replay failed with a nondeterminism error. ... [TMPRL1100] Nondeterminism error:
  Activity machine does not handle this event: HistoryEvent(id: 11, TimerStarted)
- order-o-200: ...
```

The recorded histories say that after the charge, the workflow **started a timer**. The new code **schedules an activity** at that point instead. For `o-100`, which has finished, that only matters if someone replays it, for example to query it. For `o-200`, which is still waiting, it would break the order the moment a new worker picked it up.

## Fix it with a patch

`patched()` from `@temporalio/workflow` lets old and new executions take different paths:

```ts ins={1,5-8} del={4}
import { condition, patched } from '@temporalio/workflow';

    this.status = 'paid';
    await this.payments.sendReceipt(input.orderId, input.cents);
    // Orders started before receipts existed replay without this step.
    if (patched('send-receipt')) {
      await this.payments.sendReceipt(input.orderId, input.cents);
    }
```

During replay, `patched('send-receipt')` returns `false` for histories recorded before the patch existed, so they skip the receipt and replay as before. New executions get `true`, send the receipt, and record a marker so that their own replays take the same branch.

```sh
pnpm test
```

```text
 Test Files  3 passed (3)
      Tests  10 passed (10)
```

`o-200`, still waiting in your dev server, keeps working: the worker restarted with the new code and replayed its history through the patched branch. Once no execution that started before the patch is still running, replace `patched()` with `deprecatePatch()` and remove the old branch. [Versioning & safe deploys](/norn/guides/versioning/) covers that, worker versioning (the alternative to patching), and a deploy checklist.

:::tip[Renames are breaking changes too]
Running executions refer to workflow types, signals, queries, updates, activities and task queues by name. `norn gen` records every name in `norn.lock.json`, and refuses to generate if one disappears, until you confirm the rename with `norn gen --accept-rename`.
:::

Next: [build for production](/norn/tutorial/5-production/).
