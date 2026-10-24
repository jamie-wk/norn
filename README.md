# Norn

Write [Temporal](https://temporal.io) workflows and activities as plain, typed TypeScript classes.

Norn is a thin, open-source layer on the official Temporal TypeScript SDK (1.24). It keeps everything Temporal gives you (durable execution, the deterministic workflow sandbox, retries, timers, signals, updates) and changes how you declare it: workflows are decorated classes, activities are plain classes, and the client is typed from the workflow class. No codegen, one package.

**Documentation:** https://jamie-wk.github.io/norn/

## Quick start

```sh
pnpm create @norn-ts my-app
cd my-app
pnpm dev     # starts a local Temporal server and the worker
pnpm order   # in another terminal: start an order workflow
```

## What it looks like

```ts
// src/workflows/order.workflow.ts
import { condition } from '@temporalio/workflow';
import { Query, Signal, Workflow, useActivities } from '@norn-ts/norn/workflow';
import type { PaymentActivities } from '../activities/payment.activities';

@Workflow({ taskQueue: 'orders', id: 'order-{orderId}' })
export class OrderWorkflow {
  private status: 'pending' | 'paid' | 'refunded' = 'pending';
  private canceled = false;
  private readonly payments = useActivities<PaymentActivities>('payments', {
    timeout: '30s',
    retries: 3,
    nonRetryable: ['CardDeclinedError'],
  });

  @Signal() cancel(_reason: string) {
    this.canceled = true;
  }

  @Query() getStatus() {
    return this.status;
  }

  async run(input: { orderId: string; cents: number }) {
    const charge = await this.payments.charge(input.orderId, input.cents);
    this.status = 'paid';
    if (await condition(() => this.canceled, '5 minutes')) {
      await this.payments.refund(charge.id);
      this.status = 'refunded';
    }
    return this.status;
  }
}
```

```ts
// src/activities/payment.activities.ts: a plain class, where the I/O happens
export class PaymentActivities {
  constructor(private readonly gateway: PaymentGateway) {}
  async charge(orderId: string, cents: number) {
    return this.gateway.charge({ orderId, cents, idempotencyKey: `charge-${orderId}` });
  }
  async refund(chargeId: string) {
    return this.gateway.refund(chargeId);
  }
}
```

```ts
// src/worker.ts
import { createWorker } from '@norn-ts/norn/worker';

const worker = await createWorker({
  workflows: new URL('./workflows/index.ts', import.meta.url),
  activities: { payments: new PaymentActivities(new StripeGateway()) },
});
await worker.run();
```

```ts
// anywhere: the workflow class is the contract
import { createClient } from '@norn-ts/norn/client';

const orders = createClient().workflow(OrderWorkflow);
const order = await orders.start({ orderId: 'o-42', cents: 1999 }); // ID "order-o-42"
await order.signal('cancel', 'changed my mind'); // argument types checked
```

The workflow imports the activity class with `import type`, so activity code never reaches the workflow sandbox. Inputs, results, handler arguments and activity signatures are checked at compile time.

## The package

| Import | What |
| --- | --- |
| `@norn-ts/norn/workflow` | `@Workflow`, `@Signal`, `@Query`, `@Update`, `@Validate`, `useActivities()`, `useChild()`, `useExternal()`, `continueAsNew()`, `setSearchAttributes()`, `asFailure()`. Safe in the workflow sandbox. |
| `@norn-ts/norn/worker` | `createWorker()`, `bundleWorkflows()`. |
| `@norn-ts/norn/client` | `createClient()`: typed start, execute, signal, query, update, with-start operations, list and count, with Norn errors. |
| `@norn-ts/norn/testing`, `/vitest`, `/vite` | `createTestEnv()`, `useTestEnv()`, `standardDecorators()`. |
| `@norn-ts/norn` | Errors with codes and HTTP statuses, durations, shared types. |
| [`@norn-ts/create`](./packages/create) | `pnpm create @norn-ts`. |

## Using Norn with coding agents

[`skills/norn/SKILL.md`](skills/norn/SKILL.md) is an [agent skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview) that teaches coding agents Norn's conventions: what may run in the workflow sandbox, how workflows, activities and the worker connect, and how to write tests. For Claude Code, copy the `skills/norn` folder into your project's `.claude/skills/`. The docs site also serves [`llms.txt`](https://jamie-wk.github.io/norn/llms.txt).

## Why the name Norn

In Norse myth, the three Norns, **Urðr**, **Verðandi** and **Skuld**, sit at the well beneath Yggdrasil and weave the threads of fate: what has been, what is becoming, and what shall be.

A Temporal workflow is woven from the same three threads. Its **event history** is what has been: every decision, recorded and replayable. The **running workflow** is what is becoming: code reacting to signals and updates as they arrive. Its **timers and schedules** are what shall be: the reminder in three days, the settlement window, the nightly report.

## Requirements

- **Node.js 22.18 or later** (tested on 22, 24 and 26).
- **Temporal TypeScript SDK 1.24** (`@temporalio/*` `^1.24.0`) and a Temporal service: Temporal Cloud, a self-hosted cluster, or `temporal server start-dev` locally.
- **TypeScript with TC39 standard decorators.** Never enable `experimentalDecorators`: Norn's decorators are standard decorators, and the legacy ones have a different signature.

## Links

- Documentation: https://jamie-wk.github.io/norn/
- Source and issues: https://github.com/jamie-wk/norn
- Changelog: [`packages/norn/CHANGELOG.md`](./packages/norn/CHANGELOG.md) and GitHub releases

## Contributing

Contributions are welcome. Open an issue first for anything larger than a small fix, so we can agree on the approach.

The repository is a pnpm workspace (pnpm 10, Node 22.18+):

```sh
pnpm install
pnpm build                 # the packages
pnpm lint                  # oxlint --deny-warnings
pnpm typecheck
pnpm test                  # unit tests
pnpm test:integration      # against a real Temporal dev server and the time-skipping test server
pnpm check:deps && pnpm check:pack
pnpm docs:dev              # the documentation site
```

Integration tests download Temporal's binaries unless `NORN_TEMPORAL_CLI_PATH` / `NORN_TEMPORAL_TEST_SERVER_PATH` point at existing ones (put them in a gitignored `.env.test.local`; on a Mac, `brew install temporal`).

Ground rules:

- Write the failing test first, and cover both the happy and the sad paths.
- TC39 standard decorators only; never `experimentalDecorators`.
- Keep type safety end to end; don't loosen types to make something compile.
- `@norn-ts/norn` has no runtime dependencies (the Temporal SDK packages are peers), and nothing that runs in the workflow sandbox imports Node APIs (`pnpm check:deps` enforces this).
- Use pnpm, not npm or yarn. Add a changeset (`pnpm changeset`) for user-facing changes.

## License

[MIT](./LICENSE) © Jamie King
