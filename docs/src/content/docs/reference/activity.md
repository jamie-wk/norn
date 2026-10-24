---
title: "@norn-ts/activity"
description: Activity classes, error mapping, context helpers and the dependency-injection container.
sidebar:
  order: 4
---

`@norn-ts/activity` defines activities as decorated classes, and has a small dependency-injection container that builds their services once, scopes some of them to a single execution and disposes everything on shutdown.

- **`@Activities`**, **`@Activity`**, **`@NonRetryable`**: activity classes whose options travel to workflows through the generated `.norn/activities.ts`, and errors that should never be retried.
- **`@Service`**, **`token()`**, **`provide()`**, **`createContainer()`**: constructor injection without `reflect-metadata` or parameter decorators. `norn gen` reads constructor parameter types from your source and writes the wiring into `.norn/container.ts`.
- **Error mapping**: thrown errors become `ApplicationFailure`s whose type is the error's name, so workflows can match them with `asFailure()`. Optional HTTP-status and custom rules decide what is retried.
- **Context helpers**: `idempotencyKey()`, `heartbeat()`, `lastHeartbeat()`, `cancellationSignal()`, `activityInfo()` and `getCorrelationId()`.

This package runs on the worker side (Node), never in the workflow sandbox. Workflows call activities through `useActivities()` from [`@norn-ts/workflow`](/norn/reference/workflow/). For a task-oriented walkthrough, see [Activities](/norn/guides/activities/) and [Dependency injection](/norn/guides/dependency-injection/).

## Install

```sh
pnpm add @norn-ts/activity @temporalio/activity @temporalio/common
```

`@temporalio/activity` and `@temporalio/common` (^1.24.0) are peer dependencies. Requires Node 22.18+ and TypeScript with TC39 standard decorators (no `experimentalDecorators`). Add [`@norn-ts/cli`](/norn/reference/cli/) for `norn gen` and [`@norn-ts/worker`](/norn/reference/worker/) to run activities.

## Example

```ts
// src/services/payment-gateway.ts
import { Service, token } from '@norn-ts/activity';
import { HttpClient } from './http.js';

export interface PaymentGateway {
  charge(request: { orderId: string; amountCents: number; card: string; idempotencyKey: string }): Promise<Charge>;
  refund(request: { chargeId: string; idempotencyKey: string }): Promise<{ refundId: string }>;
}
// same name as the interface
export const PaymentGateway = token<PaymentGateway>('PaymentGateway');

@Service({ provides: PaymentGateway })
export class HttpPaymentGateway implements PaymentGateway {
  constructor(private readonly http: HttpClient) {}
  // ...
}
```

```ts
// src/activities/payment.activities.ts
import { Activities, Activity, NonRetryable } from '@norn-ts/activity';
import { PaymentDeclinedError } from '../domain.js';
import { PaymentGateway } from '../services/payment-gateway.js';

@Activities({ prefix: 'payments.' })
export class PaymentActivities {
  // injected: HttpPaymentGateway
  constructor(private readonly gateway: PaymentGateway) {}

  /** The order ID is the idempotency key, so retries never double-charge. */
  @Activity({ timeout: '30s', retries: 5, retry: { initialInterval: '200ms', maximumInterval: '5s' } })
  @NonRetryable([PaymentDeclinedError])
  async charge(orderId: string, amountCents: number, card: string) {
    return this.gateway.charge({ orderId, amountCents, card, idempotencyKey: `charge-${orderId}` });
  }

  @Activity({ timeout: '30s', retries: 10 })
  async refund(orderId: string, chargeId: string) {
    return this.gateway.refund({ chargeId, idempotencyKey: `refund-${orderId}` });
  }
}
```

```ts
// src/providers.ts: values the container can't build from a class
import { provide } from '@norn-ts/activity';
import { createClient } from '@norn-ts/client';

export const providers = [
  provide(AppConfig, () => loadConfig()),
  provide(TemporalClient, () => createClient(), { dispose: (client) => client.close() }),
];
```

Point `norn.config.ts` at the providers module (`providers: 'src/providers.ts'`) and run `norn gen`. The worker registers `payments.charge` and `payments.refund`, and the workflow side calls them with the same options:

```ts
// in a workflow; PaymentActivities comes from .norn/activities.js
private readonly payments = useActivities(PaymentActivities);
const charge = await this.payments.charge(orderId, totalCents, card);
```

## Activities

### `@Activities(options?)`

Marks a class whose `@Activity` methods are registered with the worker.

| Option | Description |
| --- | --- |
| `prefix` | Prefix for every activity name in the class, such as `'payments.'`. Default none. Must be a string. |
| `inject` | Explicit constructor dependencies (classes or tokens), in parameter order. Overrides what `norn gen` infers. |

A class can be decorated with `@Activities` once, and needs at least one `@Activity` method. Two methods of one class, or two classes in one container, registering the same name is a `NornConfigError`.

### `@Activity(options?)`

Registers a method as an activity named `prefix + (name ?? methodName)`. Options are recorded in the generated reference, so workflows schedule the activity with exactly these settings. They are validated when the decorator runs (class definition time), and invalid values throw `NornConfigError`. The method must be public, non-static and string-named.

| Option | Type | Description |
| --- | --- | --- |
| `name` | `string` | Registered name without the prefix. Default: the method name. Must not be empty. |
| `timeout` | `Duration` | Start-to-close: how long one attempt may run. Default 1 minute when neither `timeout` nor `scheduleToClose` is set. Must be greater than zero. |
| `scheduleToClose` | `Duration` | Total time across all attempts. Must be greater than zero. |
| `scheduleToStart` | `Duration` | How long the task may wait in the queue. |
| `heartbeat` | `Duration` | Heartbeat timeout. |
| `retries` | `number` | Retries after the first attempt (non-negative integer): `0` is a single attempt, `3` up to four. |
| `retry` | `RetryOptions` | `initialInterval`, `backoffCoefficient` (at least 1), `maximumInterval`, `maximumAttempts` (including the first; positive integer). Intervals must be greater than zero. Use `retries` or `retry.maximumAttempts`, not both. |
| `local` | `boolean` | Run as a local activity. `heartbeat`, `taskQueue` and `scheduleToStart` are ignored. |
| `nonRetryable` | `string[]` | Error type names never retried. Filled in from `@NonRetryable`. |
| `taskQueue` | `string` | Run on a different task queue than the calling workflow. |
| `summary` | `string` | Shown in the Temporal UI. |

`Duration` is milliseconds or a string such as `'30s'`, `'5 minutes'`, `'1h30m'` or `'PT2M'` (see [Durations](/norn/reference/core/)). Without `retries` or `retry.maximumAttempts`, Temporal retries forever, bounded only by `scheduleToClose`. The translation to Temporal options is `toActivityOptions()` in [`@norn-ts/core`](/norn/reference/core/). Retry choices are explained in [Retries: `retries` vs `retry`](/norn/guides/activities/#retries-retries-vs-retry).

### `@NonRetryable(errors?)`

```ts
function NonRetryable(errors?: readonly ErrorClass[]): MethodDecorator & ClassDecorator;
```

`@NonRetryable([OutOfStockError])` fails the activity immediately (no retries) when it throws one of those classes (`instanceof`). `@NonRetryable()` makes every error final. On a class it applies to every method; a method-level `@NonRetryable` replaces the class-level one for that method. The class names are recorded in the generated reference, so the workflow-side retry policy agrees. Passing anything other than an array of classes throws `NornConfigError`.

`ErrorClass` is `abstract new (...args: any[]) => Error`.

## Dependency injection

The [Dependency injection guide](/norn/guides/dependency-injection/) covers scopes, tokens and overrides with examples. The API:

### Services and tokens

```ts
function Service(options?: { provides?: InjectionKey; scope?: 'singleton' | 'activity'; inject?: readonly InjectionKey[] }): ClassDecorator;
function token<T>(name: string): Token<T>;
```

| `@Service` option | Default | Description |
| --- | --- | --- |
| `provides` | the class itself | The class or token the class is registered under. |
| `scope` | `'singleton'` | `'singleton'` is one instance per worker; `'activity'` is a new instance per activity execution. |
| `inject` | inferred by `norn gen` | Explicit constructor dependencies, in parameter order. |

- Only one provider per key is allowed in a container.
- A class listed in the container's `services` without `@Service` is a singleton registered under itself.
- A token is the runtime key for an interface. Give it the interface's name; constructor parameters typed with the interface then resolve to it, and `norn gen` writes the wiring. A parameter typed with an interface that has no same-named token is reported by `norn gen`. `token()` with an empty name throws `NornConfigError`.
- Primitive constructor parameters cannot be injected by type; group them in a configuration token.

`InjectionKey<T>` is a class or a `Token<T>`; `Resolved<K>` is the type it resolves to.

### Providers

```ts
function provide<K extends InjectionKey>(
  key: K,
  factory: (ctx: ProviderContext, ...deps: any[]) => Resolved<K> | Promise<Resolved<K>>,
  options?: { scope?: 'singleton' | 'activity'; deps?: readonly InjectionKey[]; dispose?: (value: Resolved<K>) => unknown },
): Provider<Resolved<K>>;

interface ProviderContext {
  // the running activity, for activity-scoped providers
  activity?: Info;
  // prefer deps, which the container can check up front
  resolve<K extends InjectionKey>(key: K): Promise<Resolved<K>>;
}
```

Registers a factory for configuration, connection pools and SDK clients. The factory receives the context, then the resolved `deps` in order, and may be async.

| Option | Default | Description |
| --- | --- | --- |
| `scope` | `'singleton'` | `'activity'` creates a fresh value per activity execution. |
| `deps` | `[]` | Dependencies resolved before the factory runs, passed after the context argument. |
| `dispose` | `Symbol.asyncDispose`, then `Symbol.dispose` | Cleans the value up when its scope ends. |

```ts
provide(Db, (_ctx, config: AppConfig) => new pg.Pool({ connectionString: config.databaseUrl }), {
  deps: [AppConfig],
  dispose: (pool) => pool.end(),
});

provide(RequestLog, (ctx) => rootLogger.child({ activityId: ctx.activity?.activityId }), { scope: 'activity' });
```

### `createContainer(options?)`

```ts
function createContainer(options?: ContainerOptions): Container;

interface ContainerOptions {
  providers?: readonly Provider<any>[];
  // { cls, deps? }
  services?: readonly ClassEntry[];
  activities?: readonly ClassEntry[];
  // replace any dependency; never disposed
  overrides?: ReadonlyArray<readonly [InjectionKey, unknown]>;
  errors?: ErrorMappingOptions;
}

interface Container extends AsyncDisposable {
  // resolves a singleton, creating it and its dependencies on first use
  resolve<K extends InjectionKey>(key: K): Promise<Resolved<K>>;
  // the worker's activity map, by registered name
  activities(): Promise<Record<string, ActivityFunction>>;
}
```

The generated `.norn/container.ts` calls this with every `@Service` and `@Activities` class and their dependency lists (`deps` on an entry takes precedence over `inject`), and the worker calls `activities()`. You can call it directly in scripts and unit tests:

```ts
import { createContainer, provide } from '@norn-ts/activity';

await using container = createContainer({
  providers: [provide(AppConfig, () => ({ providerUrl: 'http://localhost:4010', httpTimeoutMs: 1_000 }))],
  services: [{ cls: HttpPaymentGateway, deps: [HttpClient] }],
  activities: [{ cls: PaymentActivities, deps: [PaymentGateway] }],
  overrides: [[HttpClient, fakeHttp]],
  errors: { http: true },
});
// { 'payments.charge': fn, 'payments.refund': fn }
const activities = await container.activities();
```

`createContainer()` checks the graph before creating anything, and throws `NornConfigError` for:

- **Duplicate providers**: `There is more than one provider for PaymentGateway`.
- **Cycles**: `Dependency cycle: OrderService -> PricingService -> OrderService`.
- **Missing providers**: `No provider for Db, required by BankingService. Register it with provide() or @Service`.
- **Captive dependencies**: a singleton that depends on an activity-scoped value is refused. An activity class that depends on one becomes activity-scoped itself, automatically.
- **Constructor arity**: a class whose constructor declares more parameters than it has known dependencies fails with a hint to run `norn gen` or add `inject`.

### Lifecycle

- `activities()` creates every singleton up front, so a bad provider fails the worker at startup rather than the first activity. A failed creation is retried on the next call or activity attempt.
- `resolve()` outside a running activity can only resolve singletons; an activity-scoped key throws `NornConfigError`.
- Each activity execution gets its own scope. Its activity-scoped values are disposed in reverse creation order when it finishes, whatever the outcome. Their dispose errors are logged as a warning, not thrown, so commit work inside the activity rather than in `dispose`.
- Disposing the container (`await using`, or `container[Symbol.asyncDispose]()`) waits for pending creations, then disposes singletons in reverse creation order. One failure is rethrown; several are thrown as one `AggregateError`. Overrides are never disposed. After disposal, `resolve()` and `activities()` reject.

## Error mapping

Every activity the container builds converts thrown errors with `mapActivityError()`:

1. Temporal failures (`ApplicationFailure`, `CancelledFailure`, ...) pass through unchanged.
2. Errors matched by `@NonRetryable` become non-retryable `ApplicationFailure`s.
3. `errors.map(error, activityType)` decides next: `'retryable'`, `'non-retryable'`, your own `ApplicationFailure`, or `undefined` to fall through.
4. With `errors.http: true`, an error with an HTTP `status`, `statusCode` or `response.status` from 400 to 499 is final, except 408 and 429.
5. Everything else is a retryable `ApplicationFailure`.

Errors thrown while creating the activity class instance go through the same steps, without `@NonRetryable`.

The failure's type is `errorTypeOf(error)` from [`@norn-ts/core`](/norn/reference/core/): the error's `name` if set, else its class name. Set `override name = 'PaymentDeclinedError'` on error classes so the name survives minification and matches `asFailure(error, PaymentDeclinedError)` in workflows. The original stack is kept. See [Errors](/norn/guides/errors/#activity-errors) for the workflow side.

```ts
const worker = await createWorker({ registry, container: { errors: { http: true, map: (error) => (error instanceof RateLimitError ? 'retryable' : undefined) } } });
```

```ts
function mapActivityError(error: unknown, activityType: string, nonRetryable: readonly ErrorClass[] | true | undefined, options?: ErrorMappingOptions): unknown;

type ErrorDecision = 'retryable' | 'non-retryable' | ApplicationFailure | undefined;

interface ErrorMappingOptions {
  http?: boolean;
  map?: (error: unknown, activityType: string) => ErrorDecision;
}
```

A non-boolean `http` or a non-function `map` throws `NornConfigError` when the container is created.

## Context helpers

Call these inside a running activity, or in services it calls. Outside one they throw `NornConfigError` (except the correlation helpers, which return `undefined`).

| Helper | Description |
| --- | --- |
| `activityInfo()` | The SDK's `Info`: activity ID and type, attempt, task queue, workflow execution. |
| `idempotencyKey(suffix?)` | `workflowId/runId/activityId` (plus `/suffix`): stable across retries of one scheduled activity. An activity started outside a workflow gets `activity/activityId`. For money movement, prefer a business key such as `charge-${paymentId}`. |
| `heartbeat(details?)` | Records progress; required more often than the `heartbeat` timeout. |
| `lastHeartbeat<T>()` | Details of the last heartbeat from a previous attempt, so a retry can resume. |
| `cancellationSignal()` | An `AbortSignal` that fires when the activity is canceled; pass it to `fetch()`. |
| `getCorrelationId()` | The correlation ID the workflow carried, if any (set by the [`@norn-ts/worker`](/norn/reference/worker/) activity interceptor). |
| `runWithCorrelationId(id, fn)` | Runs `fn` with a correlation ID and returns its result. |

```ts
@Activity({ timeout: '2 hours', heartbeat: '30s', retries: 5 })
async importRows(fileId: string) {
  let offset = lastHeartbeat<number>() ?? 0;
  for await (const batch of this.files.read(fileId, { offset, signal: cancellationSignal() })) {
    await this.db.insert(batch);
    offset += batch.length;
    heartbeat(offset);
  }
  return offset;
}
```

The correlation ID is stored in one process-wide `AsyncLocalStorage` shared with [`@norn-ts/client`](/norn/reference/client/), so a client call made from an activity carries the same ID onward, even with separate copies of the packages installed. See [Observability](/norn/guides/observability/).

## Exports

| Export | Kind |
| --- | --- |
| `Activities(options?)`, `ActivitiesOptions` | Class decorator |
| `Activity(options?)`, `ActivityOptions`, `Duration` | Method decorator (option types re-exported from `@norn-ts/core`) |
| `NonRetryable(errors?)`, `ErrorClass` | Method or class decorator |
| `Service(options?)`, `ServiceOptions`, `Scope` | Class decorator |
| `token<T>(name)`, `Token<T>`, `InjectionKey<T>`, `Resolved<K>` | Injection keys |
| `provide(key, factory, options?)`, `Provider`, `ProviderContext`, `ProviderOptions` | Providers |
| `createContainer(options?)`, `Container`, `ContainerOptions`, `ClassEntry`, `ActivityFunction` | Container |
| `mapActivityError(error, activityType, nonRetryable, options?)`, `ErrorMappingOptions`, `ErrorDecision` | Error mapping |
| `activityInfo()`, `idempotencyKey(suffix?)`, `heartbeat(details?)`, `lastHeartbeat()`, `cancellationSignal()` | Activity context |
| `getCorrelationId()`, `runWithCorrelationId(id, fn)` | Correlation IDs |
| `describeActivities(cls)`, `describeService(cls)`, `ActivitiesDefinition`, `ActivityMethodDefinition`, `ServiceDefinition` | Introspection (used by the container and tooling) |
