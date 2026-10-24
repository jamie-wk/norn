# @norn-ts/testing

Test helpers for [Norn](https://jamie-wk.github.io/norn/) apps: Temporal test environments with time skipping, typed activity mocks, an in-memory fake client for API tests, replay checks, and a Vitest plugin for TC39 standard decorators.

## Install

```sh
pnpm add -D @norn-ts/testing @temporalio/testing @temporalio/worker @temporalio/client @temporalio/common
```

## Example

```ts
import { expect, it } from 'vitest';
import { createTestEnv, mockActivities } from '@norn-ts/testing';
import { NotificationActivities } from '../.norn/activities.js';
import { DailyReportWorkflow } from '../.norn/contracts.js';
import { registry } from '../.norn/registry.js';

it('emails the report', async () => {
  const notify = mockActivities(NotificationActivities, { email: async () => ({ messageId: 'm' }) });
  await using env = await createTestEnv({ registry, mode: 'time-skipping', activities: notify });

  expect(await env.workflow(DailyReportWorkflow).execute()).toBe('sent');
  expect(notify.email.calls).toHaveLength(1);
});
```

Full API: [reference](https://jamie-wk.github.io/norn/reference/testing/) · [Norn docs](https://jamie-wk.github.io/norn/)

## License

MIT
