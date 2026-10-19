import type { Context, Env, Handler } from 'hono';
import type { HandleTarget, NornClient } from '@norn-ts/client';
import {
  NornConfigError,
  NornError,
  isWorkflowContract,
  type AnyWorkflowContract,
  type RefArgs,
  type RefResult,
  type WorkflowClosedError,
  type WorkflowNotFoundError,
} from '@norn-ts/core';
import { respondWithError } from './errors.js';
import { isPlainObject, isPositiveInteger, readBody } from './internal.js';

type MaybePromise<T> = T | Promise<T>;
type Keys<R> = keyof R & string;
type IsAny<T> = 0 extends 1 & T ? true : false;
/** Handler arguments; `unknown[]` for loosely typed contracts (`AnyWorkflowContract`). */
type Args<R> = IsAny<R> extends true ? unknown[] : RefArgs<R> extends infer A extends unknown[] ? A : never;
/** `args` may be left out when the handler takes no arguments. */
type ArgsField<A extends unknown[]> = [] extends A ? { args?: A } : { args: A };

/** Sends a signal: `{ workflow: Orders, target: { orderId }, signal: 'paid', args: [payment] }`. */
export type WebhookSignalAction<C extends AnyWorkflowContract = AnyWorkflowContract> = {
  [K in Keys<C['signals']>]: { workflow: C; target: HandleTarget<C>; signal: K; update?: never } & ArgsField<Args<C['signals'][K]>>;
}[Keys<C['signals']>];

/** Runs an update and waits for its result, which is returned in the response's `results`. */
export type WebhookUpdateAction<C extends AnyWorkflowContract = AnyWorkflowContract> = {
  [K in Keys<C['updates']>]: { workflow: C; target: HandleTarget<C>; update: K; signal?: never } & ArgsField<Args<C['updates'][K]>>;
}[Keys<C['updates']>];

/** One thing to do for a webhook event, typed by the contract's signals and updates. */
export type WebhookAction<C extends AnyWorkflowContract = AnyWorkflowContract> = WebhookSignalAction<C> | WebhookUpdateAction<C>;

/** Passed to `onClosed` / `onNotFound` functions. */
export interface WebhookFailureInfo<Err extends NornError> {
  action: WebhookAction;
  /** Position of the action in the list `map` returned. */
  index: number;
  error: Err;
}

/**
 * - `'ignore'`: skip the action; when nothing else was accepted, respond 200 `{ ignored: 'closed' | 'not_found' }`.
 * - `'error'`: stop and throw the error to `app.onError` (409 `WORKFLOW_CLOSED` / 404 `WORKFLOW_NOT_FOUND` with `nornErrorHandler()`).
 * - a function: return a `Response` to stop and send it, or nothing to ignore the action.
 */
export type WebhookFailurePolicy<E extends Env, Err extends NornError> =
  | 'ignore'
  | 'error'
  | ((info: WebhookFailureInfo<Err>, c: Context<E>) => MaybePromise<Response | void | undefined>);

export type WebhookMapResult = WebhookAction | readonly WebhookAction[] | null | undefined;

export interface WebhookOptions<E extends Env = any> {
  /**
   * Checks the request is genuine, e.g. with {@link hmacSha256Verifier}. Gets the raw body as text
   * and as the exact bytes received. Returning false → 401 `WEBHOOK_UNVERIFIED`. Required: without it,
   * anyone can signal your workflows. Pass `false` only when something in front already verifies.
   */
  verify: ((c: Context<E>, rawBody: string, rawBytes: Uint8Array) => MaybePromise<boolean>) | false;
  /** Largest body accepted; bigger ones → 413 `WEBHOOK_TOO_LARGE`, before `verify` runs. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Parses the raw body. Default `JSON.parse`. Throwing → 400 `WEBHOOK_INVALID_BODY`. */
  parse?: (rawBody: string, c: Context<E>) => unknown;
  /** Maps the event to signals and updates. `null`, `undefined` or `[]` → 202 `{ accepted: 0, ignored: 'unmapped' }`. */
  map: (body: unknown, c: Context<E>) => MaybePromise<WebhookMapResult>;
  /** What to do when the workflow is already closed. Default `'ignore'`, so late deliveries are not retried forever. */
  onClosed?: WebhookFailurePolicy<E, WorkflowClosedError>;
  /** What to do when the workflow does not exist. Default `'error'` (404). */
  onNotFound?: WebhookFailurePolicy<E, WorkflowNotFoundError>;
  /** The client to use. Default: `c.var.norn` from the `temporal()` middleware. */
  client?: NornClient;
}

/** Builds a typed signal action for {@link temporalWebhook}. */
export function signalAction<C extends AnyWorkflowContract, K extends Keys<C['signals']>>(
  workflow: C,
  target: HandleTarget<C>,
  signal: K,
  ...args: Args<C['signals'][K]>
): WebhookSignalAction<C> {
  return { workflow, target, signal, args } as unknown as WebhookSignalAction<C>;
}

/** Builds a typed update action for {@link temporalWebhook}; its result is returned in `results`. */
export function updateAction<C extends AnyWorkflowContract, K extends Keys<C['updates']>>(
  workflow: C,
  target: HandleTarget<C>,
  update: K,
  ...args: Args<C['updates'][K]>
): WebhookUpdateAction<C> {
  return { workflow, target, update, args } as unknown as WebhookUpdateAction<C>;
}

/** The result type of an update action, for typing `results` on the caller side. */
export type WebhookUpdateResult<C extends AnyWorkflowContract, K extends Keys<C['updates']>> = RefResult<C['updates'][K]>;

interface LooseHandle {
  signal(key: string, ...args: unknown[]): Promise<void>;
  update(key: string, ...args: unknown[]): Promise<unknown>;
}

interface CheckedAction {
  action: WebhookAction;
  workflow: AnyWorkflowContract;
  target: object;
  kind: 'signal' | 'update';
  key: string;
  args: unknown[];
}

function checkAction(action: unknown, index: number): CheckedAction {
  const fail = (problem: string) => new NornConfigError(`temporalWebhook: action ${index} returned by map ${problem}`);
  if (!isPlainObject(action)) throw fail('must be an object; use signalAction() or updateAction()');
  if (!isWorkflowContract(action.workflow)) throw fail('needs `workflow`: a contract from .norn/contracts.ts');
  const hasSignal = action.signal !== undefined;
  const hasUpdate = action.update !== undefined;
  if (hasSignal === hasUpdate) throw fail('needs exactly one of `signal` or `update`');
  const key = hasSignal ? action.signal : action.update;
  if (typeof key !== 'string' || key === '') throw fail(`needs a non-empty ${hasSignal ? 'signal' : 'update'} name`);
  if (typeof action.target !== 'object' || action.target === null) throw fail('needs `target`: ID fields or { workflowId }');
  if (action.args !== undefined && !Array.isArray(action.args)) throw fail('has `args` that is not an array');
  return {
    action: action as unknown as WebhookAction,
    workflow: action.workflow,
    target: action.target,
    kind: hasSignal ? 'signal' : 'update',
    key,
    args: (action.args as unknown[] | undefined) ?? [],
  };
}

function checkPolicy(name: string, policy: unknown): void {
  if (policy !== undefined && policy !== 'ignore' && policy !== 'error' && typeof policy !== 'function') {
    throw new NornConfigError(`temporalWebhook: ${name} must be 'ignore', 'error' or a function`);
  }
}

// `ignoreBOM` keeps a leading BOM in the text, so it matches the bytes the provider signed.
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * A handler for inbound webhooks (payment providers, carriers, …) that turns events into
 * signals and updates on your workflows.
 *
 * Reads the raw body once, verifies it (401), parses it (400), maps it to actions, and sends them
 * in order. Responds 202 `{ accepted: n }` (plus `results` when there were updates). A workflow
 * that already closed is ignored with 200 by default, because providers retry non-2xx responses;
 * a workflow that does not exist is a 404 by default. Other failures (for example Temporal being
 * unavailable, 503) are thrown to `app.onError`, so the provider retries.
 *
 * @example
 * ```ts
 * app.post('/webhooks/payments', temporalWebhook({
 *   verify: hmacSha256Verifier({ secret: env.WEBHOOK_SECRET, header: 'x-signature' }),
 *   map: (event: any) =>
 *     event.type === 'payment.succeeded' ? signalAction(Orders, { orderId: event.orderId }, 'paid', event.amount) : null,
 * }));
 * ```
 */
export function temporalWebhook<E extends Env = any>(options: WebhookOptions<E>): Handler<E> {
  if (typeof options !== 'object' || options === null || typeof options.map !== 'function') {
    throw new NornConfigError('temporalWebhook: `map` must be a function');
  }
  const { verify, parse, map, onClosed = 'ignore', onNotFound = 'error', client: explicitClient, maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = options;
  if (verify === undefined) throw new NornConfigError('temporalWebhook: `verify` is required (a function, or false when something in front already verifies)');
  if (verify !== false && typeof verify !== 'function') throw new NornConfigError('temporalWebhook: `verify` must be a function or false');
  if (!isPositiveInteger(maxBodyBytes)) throw new NornConfigError('temporalWebhook: `maxBodyBytes` must be a positive integer');
  if (parse !== undefined && typeof parse !== 'function') throw new NornConfigError('temporalWebhook: `parse` must be a function');
  checkPolicy('onClosed', onClosed);
  checkPolicy('onNotFound', onNotFound);

  return async (c) => {
    const bytes = await readBody(c.req.raw, maxBodyBytes);
    if (!bytes) return respondWithError(c, new NornError('WEBHOOK_TOO_LARGE', 413, `Webhook body is larger than ${maxBodyBytes} bytes`), 413);
    const raw = textDecoder.decode(bytes);

    if (verify && (await verify(c, raw, bytes)) !== true) {
      return respondWithError(c, new NornError('WEBHOOK_UNVERIFIED', 401, 'Webhook signature verification failed'), 401);
    }

    let body: unknown;
    try {
      body = parse ? await parse(raw, c) : JSON.parse(raw);
    } catch {
      const message = parse ? 'Webhook body could not be parsed' : 'Webhook body is not valid JSON';
      return respondWithError(c, new NornError('WEBHOOK_INVALID_BODY', 400, message), 400);
    }

    const mapped = await map(body, c);
    const list: readonly unknown[] = mapped === null || mapped === undefined ? [] : Array.isArray(mapped) ? mapped : [mapped];
    if (list.length === 0) return c.json({ accepted: 0, ignored: 'unmapped' }, 202);
    const actions = list.map(checkAction);
    const client = explicitClient ?? (c.var as { norn?: NornClient }).norn;
    if (!client) {
      throw new NornConfigError('temporalWebhook needs a client: add the temporal() middleware before it, or pass { client }');
    }
    // Resolve every workflow ID before sending anything (get() makes no call), so a bad mapping never half-applies an event.
    const handles = actions.map((checked) => client.workflow(checked.workflow).get(checked.target as never) as unknown as LooseHandle);

    let accepted = 0;
    const ignored: ('closed' | 'not_found')[] = [];
    const results: unknown[] = [];
    let hasUpdates = false;

    for (const [index, checked] of actions.entries()) {
      const handle = handles[index]!;
      try {
        if (checked.kind === 'update') {
          hasUpdates = true;
          results.push((await handle.update(checked.key, ...checked.args)) ?? null);
        } else {
          await handle.signal(checked.key, ...checked.args);
          results.push(null);
        }
        accepted++;
      } catch (error) {
        const code = error instanceof NornError ? error.code : undefined;
        if (code !== 'WORKFLOW_CLOSED' && code !== 'WORKFLOW_NOT_FOUND') throw error;
        const nornError = error as NornError;
        const policy = code === 'WORKFLOW_CLOSED' ? onClosed : onNotFound;
        if (policy === 'error') throw nornError;
        if (typeof policy === 'function') {
          const info = { action: checked.action, index, error: nornError } as WebhookFailureInfo<never>;
          const res = await (policy as (info: WebhookFailureInfo<never>, c: Context<E>) => MaybePromise<Response | void | undefined>)(info, c);
          if (res instanceof Response) return res;
        }
        ignored.push(code === 'WORKFLOW_CLOSED' ? 'closed' : 'not_found');
        results.push(null);
      }
    }

    if (accepted === 0) return c.json({ ignored: ignored[0] }, 200);
    return c.json({ accepted, ...(ignored.length > 0 ? { ignored: ignored.length } : {}), ...(hasUpdates ? { results } : {}) }, 202);
  };
}
