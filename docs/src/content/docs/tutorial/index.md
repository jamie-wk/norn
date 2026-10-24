---
title: Build an order service
description: Grow the starter project into an order service with shipping, compensation, validated updates, an HTTP API, replay tests and a production build.
sidebar:
  label: Overview
  order: 0
---

The [quickstart](/norn/start/quickstart/) left you with a small order workflow: it charges a card, waits five minutes for a cancellation, and refunds the charge if one arrives. In this tutorial you will grow it, one chapter at a time, into something closer to a real service:

1. **[Ship the order](/norn/tutorial/1-shipping/).** Add a second activity class with its own injected service, and refund the customer when shipping fails. You'll learn about retries, non-retryable errors and compensation.
2. **[Change the address](/norn/tutorial/2-updates/).** Let customers change their shipping address while the order waits, with an **update** that a **validator** can reject before anything is recorded.
3. **[Add an HTTP API](/norn/tutorial/3-http-api/).** Put the workflow behind a Hono API, with Norn errors mapped to HTTP status codes, and test the routes without a Temporal server.
4. **[Change workflows safely](/norn/tutorial/4-safe-changes/).** Record real histories, replay them in a test, watch a careless change break them, and fix it with a patch.
5. **[Build for production](/norn/tutorial/5-production/).** Compile, bundle the workflows ahead of time, and run the worker and API from the build.

Each chapter ends with the tests passing, so you can stop after any of them.

## Before you start

You need the project from the quickstart. If you don't have it yet:

```sh
pnpm create @norn-ts my-app
cd my-app
```

Keep `pnpm dev` running in one terminal while you work. It regenerates `.norn/` and restarts the worker whenever you save. Use a second terminal for the commands in each chapter.

If a word like _activity_, _signal_ or _replay_ is new to you, read [Durable execution in 5 minutes](/norn/concepts/durable-execution/) first. It takes five minutes, as promised.
