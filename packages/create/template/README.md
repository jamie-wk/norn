# {{name}}

A [Norn](https://jamie-wk.github.io/norn/) project: durable workflows on Temporal, in typed TypeScript.

```sh
pnpm dev        # Temporal (if it isn't running) and the worker, restarted on save
pnpm order      # in another terminal: start an order, then open the link it prints
pnpm test       # the workflow's tests, on Temporal's time-skipping server
pnpm typecheck
pnpm build      # compile for production; then `pnpm start`
```

`pnpm order cancel <id>` cancels an order within 5 minutes (it's refunded); `pnpm order status <id>` asks it for its status.

## What's where

| Path | What |
| --- | --- |
| `src/workflows/order.workflow.ts` | The workflow: charge, wait for a cancellation, maybe refund. Deterministic, replayed by Temporal. |
| `src/workflows/index.ts` | Exports every workflow the worker runs. |
| `src/activities/payment.activities.ts` | Activities: the steps that do I/O. A plain class; Temporal retries them. |
| `src/services/payment-gateway.ts` | What the activities call. Swap the fake for a real provider in `src/worker.ts`. |
| `src/worker.ts` | The worker process. |
| `src/order.ts` | A client script that starts, signals and queries orders. |
| `test/order.workflow.test.ts` | Tests with fake activities. |

## Next steps

- [Workflows](https://jamie-wk.github.io/norn/guides/workflows/), [activities](https://jamie-wk.github.io/norn/guides/activities/) and [testing](https://jamie-wk.github.io/norn/guides/testing/).
- [Worker & deployment](https://jamie-wk.github.io/norn/guides/worker/) when you're ready to ship.
