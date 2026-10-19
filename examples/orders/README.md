# Orders example

A small but complete Norn application: an online store's order lifecycle, split into the pieces a
real deployment has.

| Package | What it is |
| --- | --- |
| [`worker/`](./worker) | Workflows (`OrderWorkflow`, `ShipmentWorkflow`, `LoyaltyWorkflow`, scheduled `DailyReportWorkflow`), activities and the services they inject. `norn gen` writes `.norn/` from these classes. |
| [`contracts/`](./contracts) | The workflow contracts `norn gen` emits for other services. Types only reach the API through `import type`, so the API never bundles worker code. |
| [`api/`](./api) | A Hono API that starts orders, adds items with update-with-start, cancels, reads state, and receives signed payment webhooks. |
| [`provider/`](./provider) | A scriptable stand-in for the payment, shipping and email provider, used locally and by the end-to-end tests. |

## What it demonstrates

- **Workflows as classes**: `@Signal` (`cancel`, deduplicated `paymentEvent`), `@Query` (`view`),
  `@Update` with `@Validate` (`addItem`, `submit`), a state machine with `transitions()`, typed search
  attributes, a child workflow on its own task queue, continue-as-new in `LoyaltyWorkflow`, and a
  `@Schedule`.
- **Activities with dependency injection**: `PaymentActivities` receives a `PaymentGateway`
  interface token implemented by `HttpPaymentGateway`, which receives `HttpClient`, which receives
  `AppConfig` from a `provide()` factory — wired by `norn gen` from constructor types alone.
- **Errors that mean something**: a declined card (`402`) becomes a non-retryable
  `PaymentDeclinedError` the workflow handles; `503`s are retried with the same idempotency key;
  the API answers `404`/`409`/`422` for unknown, finished and invalid requests.
- **Production worker**: health checks, graceful SIGTERM drain, prebuilt workflow bundle, optional
  payload encryption and a codec endpoint for the Temporal UI, correlation IDs from the HTTP request
  to the provider.

## Run it locally

You need Node 22.18+ and the [Temporal CLI](https://docs.temporal.io/cli).

```sh
pnpm install
pnpm e2e:build                       # build packages, run norn gen, compile the worker and its bundle
temporal server start-dev --search-attribute CustomerId=Keyword --search-attribute OrderStatus=Keyword

pnpm --filter @norn/example-orders-provider start          # :4010
pnpm --filter @norn/example-orders-worker start            # polls the "orders" and "shipping" queues
WEBHOOK_SECRET=dev-secret pnpm --filter @norn/example-orders-api start   # :3000; the secret verifies payment webhooks
```

```sh
curl -s localhost:3000/orders -H 'content-type: application/json' -d '{
  "orderId": "o-1", "customerId": "c-1", "email": "me@example.com", "card": "tok_visa",
  "items": [{ "sku": "sku-book", "qty": 2 }], "cancelWindow": "30s"
}'
curl -s localhost:3000/orders/o-1          # status: charging → paid → shipping → completed
curl -s localhost:3000/orders/o-1/cancel -H 'content-type: application/json' -d '{"reason":"oops"}'
```

Try `"card": "card_declined"` for a declined payment (`payment_failed`), a bad SKU for `rejected`, or
script provider failures:

```sh
curl -s localhost:4010/__script -H 'content-type: application/json' -d '{"route":"charges","status":503,"times":2}'
```

Or run everything in containers: `docker compose -f e2e/docker-compose.yml up --build`.

## Tests

- `worker/test/order.workflow.int.test.ts` — workflow behavior on the time-skipping server with
  typed activity mocks (`@norn/testing`).
- `worker/test/services.test.ts` — activities and services through the real container, with a fake
  HTTP layer.
- `api/test/app.test.ts` — API routes against `createFakeClient()`, no Temporal needed.
- `/e2e` — the whole system as real processes: happy and sad paths, worker restarts and drains,
  encryption, worker versioning and schedules.
