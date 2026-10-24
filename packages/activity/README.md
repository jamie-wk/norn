# @norn-ts/activity

Activities as decorated classes for [Norn](https://jamie-wk.github.io/norn/), with a small dependency-injection container that builds their services once, scopes some of them to a single execution and disposes everything on shutdown.

## Install

```sh
pnpm add @norn-ts/activity @temporalio/activity @temporalio/common
```

Requires Node 22.18+ and TC39 standard decorators. `@temporalio/activity` and `@temporalio/common` are peer dependencies.

## Example

```ts
import { Activities, Activity, NonRetryable } from '@norn-ts/activity';
import { PaymentDeclinedError } from '../domain.js';
import { PaymentGateway } from '../services/payment-gateway.js';

@Activities({ prefix: 'payments.' })
export class PaymentActivities {
  // injected by the container that norn gen writes
  constructor(private readonly gateway: PaymentGateway) {}

  @Activity({ timeout: '30s', retries: 5 })
  @NonRetryable([PaymentDeclinedError])
  async charge(orderId: string, amountCents: number, card: string) {
    return this.gateway.charge({ orderId, amountCents, card, idempotencyKey: `charge-${orderId}` });
  }
}
```

Full API: [reference](https://jamie-wk.github.io/norn/reference/activity/) · [Norn docs](https://jamie-wk.github.io/norn/)

## License

MIT
