# @norn-ts/codec

AES-256-GCM payload encryption with key rotation, and a payload converter that round-trips `bigint` and TC39 Temporal API values, for [Norn](https://jamie-wk.github.io/norn/) and plain Temporal TypeScript apps.

## Install

```sh
pnpm add @norn-ts/codec
```

## Example

```ts
import { Worker } from '@temporalio/worker';
import { createDataConverter } from '@norn-ts/codec';

const worker = await Worker.create({
  connection,
  taskQueue: 'orders',
  workflowsPath,
  dataConverter: createDataConverter({ keys: { '2026-10': process.env.NORN_KEY_2026_10! }, currentKeyId: '2026-10' }),
});
```

Full API: [reference](https://jamie-wk.github.io/norn/reference/codec/) · [Norn docs](https://jamie-wk.github.io/norn/)

## License

MIT
