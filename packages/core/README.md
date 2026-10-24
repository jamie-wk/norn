# @norn-ts/core

Workflow-safe building blocks shared by every [Norn](https://jamie-wk.github.io/norn/) package: typed workflow contracts, durations, ID templates, error classes with codes and HTTP statuses, `transitions()` and `businessCalendar()`. No runtime dependencies and no Node APIs, so it runs in the workflow sandbox, API servers and edge runtimes.

## Install

```sh
pnpm add @norn-ts/core
```

## Example

```ts
import { NornError, toMs, transitions } from '@norn-ts/core';

// 5_400_000
toMs('1h30m');

const status = transitions({ open: ['paid', 'canceled'], paid: [], canceled: [] }, 'open');
status.move('paid');

throw new NornError('INVITATION_EXPIRED', 410, 'This invitation has expired');
```

Full API: [reference](https://jamie-wk.github.io/norn/reference/core/) · [Norn docs](https://jamie-wk.github.io/norn/)

## License

MIT
