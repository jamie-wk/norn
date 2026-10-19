# Dependency injection & services

Activities need things: a database pool, an HTTP client with retries and timeouts, a payment provider's SDK, configuration. Norn has a small dependency container that builds them once, injects them into activity constructors, scopes some of them to a single activity execution, and disposes everything in the right order when the worker shuts down.

It is deliberately simple: no modules, no runtime reflection, no `reflect-metadata`. `norn gen` reads constructor parameter types from your source and writes the wiring into `.norn/container.ts`.

## Services

A service is a class decorated with `@Service`. Its constructor parameters are its dependencies:

```ts
// src/services/http.ts
import { Service, cancellationSignal, getCorrelationId } from '@norn/activity';
import { AppConfig } from './config.js';

@Service()
export class HttpClient {
  constructor(private readonly config: AppConfig) {}

  async post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    const correlationId = getCorrelationId();
    const res = await fetch(new URL(path, this.config.providerUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}), ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.httpTimeoutMs),
    });
    if (!res.ok) throw new HttpError(res.status, `POST ${path} failed with ${res.status}`);
    return (await res.json()) as T;
  }
}
```

Activity classes are injected the same way; any `@Activities` class can take services, tokens and provided values in its constructor.

| `@Service` option | Description |
| --- | --- |
| `provides` | The token (or class) this class is registered under. Defaults to the class itself. |
| `scope` | `'singleton'` (default): one instance per worker. `'activity'`: a new instance per activity execution. |
| `inject` | Explicit constructor dependencies, in parameter order. Overrides what `norn gen` infers. |

## Tokens: injecting interfaces

TypeScript interfaces don't exist at runtime, so the container can't use them as keys. A **token** is the runtime key for an interface. Give it the same name as the interface, and constructor parameters typed with the interface resolve to it:

```ts
// src/services/transfers.ts
import { Service, token } from '@norn/activity';

export interface TransferService {
  send(transfer: Transfer): Promise<TransferResult>;
  status(transferId: string): Promise<TransferStatus>;
}
export const TransferService = token<TransferService>('TransferService');

@Service({ provides: TransferService })
export class MoovTransferService implements TransferService {
  constructor(private readonly http: HttpClient, private readonly config: MoovConfig) {}
  // ...
}
```

```ts
@Activities({ prefix: 'payments.' })
export class PaymentActivities {
  // gets MoovTransferService
  constructor(private readonly transfers: TransferService) {}
}
```

In tests, override the token with a fake; in another environment, register a different `@Service({ provides: TransferService })` (only one provider per key is allowed per container). If an interface parameter has no same-named token, `norn gen` reports `interface-without-token` and tells you what to add.

## Providers: configuration and SDK clients {#providers}

Some dependencies are not classes you own: configuration objects, a `pg.Pool`, an SDK client, a Norn client. Register them with `provide(key, factory, options)` in your providers module, and point `norn.config.ts` at it:

```ts
// src/providers.ts
import { provide } from '@norn/activity';
import { createClient } from '@norn/client';
import pg from 'pg';
import { AppConfig, Db, TemporalClient } from './services/tokens.js';

export const providers = [
  provide(AppConfig, () => loadConfig(process.env)),
  provide(Db, (_ctx, config: AppConfig) => new pg.Pool({ connectionString: config.databaseUrl }), {
    deps: [AppConfig],
    dispose: (pool) => pool.end(),
  }),
  provide(TemporalClient, () => createClient(), { dispose: (client) => client.close() }),
];
```

```ts
// norn.config.ts
export default defineConfig({ include: ['src/**/*.ts'], providers: 'src/providers.ts' });
```

A factory receives a context object first, then the resolved `deps` in order, and may be async (`await` a connection before returning it). Options:

| Option | Description |
| --- | --- |
| `scope` | `'singleton'` (default) or `'activity'`. |
| `deps` | Dependencies resolved before the factory runs, passed after the context argument. |
| `dispose` | Cleans the value up when its scope ends. Defaults to the value's `Symbol.asyncDispose` or `Symbol.dispose`, if it has one. |

The context has `activity` (the running activity's `Info`, for activity-scoped providers) and `resolve(key)` for dependencies you can only decide on at runtime. Prefer `deps`: the container checks those up front.

Primitive values can't be injected by type (`constructor(private readonly url: string)` is reported as `unsupported-type`), so group them into a configuration token like `AppConfig` above.

## Scopes

**Singleton** (the default): created on first use and shared by every activity execution. Database pools, HTTP clients, SDK clients and configuration are singletons. `createWorker()` creates every singleton **at startup**, so a missing provider or a factory that can't connect fails the deploy, not the first payment.

**Activity**: created for one activity execution and disposed when it finishes, whatever the outcome. Use it for per-execution state: a request-scoped logger carrying the activity ID, a unit of work, a transaction. Commit inside the activity, not in `dispose`: `dispose` runs whatever the outcome, and its errors are only logged.

```ts
export const RequestLog = token<Logger>('RequestLog');

provide(RequestLog, (ctx) => rootLogger.child({ activityId: ctx.activity?.activityId, workflowId: ctx.activity?.workflowExecution?.workflowId }), {
  scope: 'activity',
});
```

An activity class that depends on an activity-scoped value becomes activity-scoped itself: it is constructed per execution. That is automatic.

### Captive dependencies

A **singleton service** that depends on an activity-scoped value would capture the first execution's value forever. The container refuses to build that graph:

```text
NornConfigError: AuditService is a singleton but depends on activity-scoped RequestLog.
Make AuditService activity-scoped, or inject a factory instead
```

Either make the service `@Service({ scope: 'activity' })`, or inject something singleton-safe (a factory function, or the root logger) and derive the per-execution value inside the method.

### Cycles and missing providers

Cycles and missing providers are reported when the container is created, before anything is constructed, including dependencies of activity-scoped values. Cycles show the full path:

```text
NornConfigError: Dependency cycle: OrderService -> PricingService -> OrderService
```

A missing provider names the key and who needed it:

```text
NornConfigError: No provider for Db, required by BankingService. Register it with provide() or @Service
```

## Disposal

When the worker shuts down (after draining in-flight activities), the container disposes every singleton it created **in reverse creation order**, so a service is disposed before the pool it uses. Activity-scoped values are disposed in reverse order at the end of each execution. Disposal uses the provider's `dispose` function, or the value's `Symbol.asyncDispose` / `Symbol.dispose`. A failed disposal never stops the others. At worker shutdown, several failures are thrown together as one `AggregateError`. At the end of an activity they are logged as a warning instead, so a cleanup problem can't turn a finished activity into a retry.

Values you pass as test overrides are owned by you and are never disposed.

## Explicit `inject` {#explicit-inject}

TC39 standard decorators have no parameter decorators, and Norn doesn't use `emitDecoratorMetadata`, so there is no runtime way to discover constructor parameter types. `norn gen` solves that statically. When you need to be explicit (the parameter type isn't a token or class, or you build a container by hand without codegen), list the keys in constructor-parameter order:

```ts
@Activities({ prefix: 'loyalty.', inject: [TemporalClient] })
export class LoyaltyActivities {
  // NornClient is a type, TemporalClient the token
  constructor(private readonly client: NornClient) {}
}

@Service({ inject: [Db, AppConfig] })
export class BankingService {
  constructor(readonly db: Db, readonly config: AppConfig) {}
}
```

A class whose constructor takes more parameters than there are known dependencies fails with a message telling you to run `norn gen` or add `inject`.

## Overrides in tests

Every way of building a container accepts `overrides`: `[key, value]` pairs that replace a dependency, whatever provided it.

```ts
// A whole workflow test, with a fake transfer service and the real activities.
await using env = await createTestEnv({
  registry,
  container: { overrides: [[TransferService, fakeTransfers]] },
});

// Or just the activities, without Temporal:
await using container = registry.createContainer({ overrides: [[TransferService, fakeTransfers]] });
// { 'payments.submit': fn, ... }
const activities = await container.activities();
```

See [Testing](/guide/testing#testing-activities) for running those functions inside a mock activity context.

## Building a container by hand

`createContainer()` is what the generated code calls; you can use it directly in scripts and unit tests:

```ts
import { createContainer, provide } from '@norn/activity';

await using container = createContainer({
  providers: [provide(AppConfig, () => ({ providerUrl: 'http://localhost:4010', httpTimeoutMs: 1_000 }))],
  services: [{ cls: HttpClient, deps: [AppConfig] }],
  activities: [{ cls: NotificationActivities, deps: [Mailer] }],
  overrides: [[Mailer, fakeMailer]],
  errors: { http: true },
});

const http = await container.resolve(HttpClient);
const activities = await container.activities();
```

`deps` on an entry is what `norn gen` writes; it takes precedence over `inject`. See the [`@norn/activity` README](https://github.com/jamie-wk/norn/tree/main/packages/activity#createcontaineroptions) for every option.
