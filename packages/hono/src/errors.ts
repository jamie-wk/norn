import type { Context, Env, ErrorHandler } from 'hono';
import { getCorrelationId, toNornError } from '@norn/client';
import { NornConfigError, NornError } from '@norn/core';
import { DEFAULT_CORRELATION_HEADER, isHeaderName, withHeader } from './internal.js';

/** Error codes produced by Norn and this package. Custom `NornError` codes are allowed too. */
export type NornErrorCode =
  | 'CONFIG'
  | 'WORKFLOW_ALREADY_STARTED'
  | 'WORKFLOW_NOT_FOUND'
  | 'WORKFLOW_CLOSED'
  | 'UPDATE_REJECTED'
  | 'QUERY_FAILED'
  | 'WORKFLOW_FAILED'
  | 'TEMPORAL_UNAVAILABLE'
  | 'INTERNAL'
  | 'WEBHOOK_UNVERIFIED'
  | 'WEBHOOK_INVALID_BODY'
  | (string & {});

/** The JSON error body: `{ error: { code, message, details, correlationId } }`. */
export interface NornErrorBody {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    correlationId: string;
  };
}

/** What {@link NornErrorHandlerOptions.format} gets besides the error. */
export interface ErrorFormatInfo {
  /** The HTTP status: the error's own, or the override configured for its code. */
  status: number;
  correlationId: string;
  /** The default JSON body. */
  body: NornErrorBody;
  /** The error as thrown, before conversion. */
  original: unknown;
}

export interface NornErrorHandlerOptions<E extends Env = any> {
  /** HTTP status per error code, e.g. `{ WORKFLOW_CLOSED: 410 }`. Must be 400–599. */
  status?: Partial<Record<NornErrorCode, number>>;
  /**
   * Whether to return the message of errors that are not Norn errors (500 `INTERNAL`). Default
   * false: the response says `Internal Server Error`. Never enable it unconditionally in production.
   */
  expose?: boolean | ((err: unknown) => boolean);
  /**
   * Called with every error (as thrown) before responding, e.g. for logging or error tracking.
   * Awaited; errors it throws are ignored. Default: `console.error` for unexpected (500 `INTERNAL`) errors.
   */
  onError?: (err: unknown, c: Context<E>) => void | Promise<void>;
  /** Builds the response yourself, from the normalized `NornError`. Not used for `HTTPException`s. */
  format?: (err: NornError, c: Context<E>, info: ErrorFormatInfo) => Response | Promise<Response>;
  /**
   * Response header for the correlation ID when the request did not go through `temporal()`
   * (which sets the header itself). Default `x-correlation-id`.
   */
  correlationHeader?: string;
}

const MIN_STATUS = 400;
const MAX_STATUS = 599;
const isErrorStatus = (status: unknown): status is number =>
  typeof status === 'number' && Number.isInteger(status) && status >= MIN_STATUS && status <= MAX_STATUS;

/** Builds the standard JSON error body. */
export function errorBody(err: NornError, correlationId: string): NornErrorBody {
  const { code, message, details } = err.toJSON();
  return { error: { code, message, details, correlationId } };
}

/** The request's correlation ID, from `temporal()` or the current async context; created when missing. */
export function correlationIdOf(c: Context): { id: string; fromMiddleware: boolean } {
  const fromVar = (c.var as { correlationId?: unknown }).correlationId;
  if (typeof fromVar === 'string') return { id: fromVar, fromMiddleware: true };
  const id = getCorrelationId() ?? globalThis.crypto.randomUUID();
  c.set('correlationId' as never, id as never);
  return { id, fromMiddleware: false };
}

/** Responds with the standard JSON error body. @internal */
export function respondWithError(c: Context, err: NornError, status: number, correlationHeader = DEFAULT_CORRELATION_HEADER): Response {
  const { id, fromMiddleware } = correlationIdOf(c);
  if (!fromMiddleware) c.header(correlationHeader, id);
  return c.json(errorBody(err, id), status as never);
}

function hasResponse(err: unknown): err is Error & { getResponse(): Response } {
  return typeof err === 'object' && err !== null && typeof (err as { getResponse?: unknown }).getResponse === 'function';
}

const INTERNAL_MESSAGE = 'Internal Server Error';

/**
 * An `app.onError()` handler that turns errors into JSON responses:
 *
 * - `NornError`s (from `@norn/client`, `@norn/core` or your own) → their `status` (or the
 *   configured override) and `{ error: { code, message, details, correlationId } }`.
 * - Raw Temporal client errors are converted with `toNornError()` first, so a gRPC
 *   `UNAVAILABLE` still becomes 503 `TEMPORAL_UNAVAILABLE`.
 * - hono `HTTPException`s → their own response, as with hono's default handler.
 * - Anything else → 500 `{ error: { code: 'INTERNAL', message: 'Internal Server Error' } }`.
 *
 * The correlation ID is included in the body and the response header.
 *
 * @example
 * ```ts
 * app.onError(nornErrorHandler({ status: { WORKFLOW_CLOSED: 410 }, onError: (err) => logger.error(err) }));
 * ```
 */
export function nornErrorHandler<E extends Env = any>(options: NornErrorHandlerOptions<E> = {}): ErrorHandler<E> {
  const { status: overrides = {}, expose = false, format, correlationHeader = DEFAULT_CORRELATION_HEADER } = options;
  for (const [code, status] of Object.entries(overrides)) {
    if (!isErrorStatus(status)) {
      throw new NornConfigError(`nornErrorHandler: status for ${code} must be an integer from ${MIN_STATUS} to ${MAX_STATUS}, got ${String(status)}`);
    }
  }
  if (typeof expose !== 'boolean' && typeof expose !== 'function') throw new NornConfigError('nornErrorHandler: expose must be a boolean or a function');
  if (format !== undefined && typeof format !== 'function') throw new NornConfigError('nornErrorHandler: format must be a function');
  if (options.onError !== undefined && typeof options.onError !== 'function') throw new NornConfigError('nornErrorHandler: onError must be a function');
  if (!isHeaderName(correlationHeader)) throw new NornConfigError('nornErrorHandler: correlationHeader must be a valid header name');

  const shouldExpose = (err: unknown) => (typeof expose === 'function' ? expose(err) : expose);

  const normalize = (err: unknown): NornError => {
    const converted = err instanceof NornError ? err : toNornError(err, { workflowId: 'unknown' });
    if (converted instanceof NornError) return converted;
    const message = shouldExpose(err) && err instanceof Error && err.message ? err.message : INTERNAL_MESSAGE;
    return new NornError('INTERNAL', 500, message, { cause: err });
  };

  const report = async (err: unknown, c: Context<E>, normalized: NornError | undefined) => {
    try {
      if (options.onError) await options.onError(err, c);
      else if (normalized?.code === 'INTERNAL') console.error(err);
    } catch {
      // A broken logger must not turn an error response into a crash.
    }
  };

  return async (err, c) => {
    if (hasResponse(err) && !(err instanceof NornError)) {
      await report(err, c, undefined);
      const res = err.getResponse();
      const { id, fromMiddleware } = correlationIdOf(c as Context);
      if (!fromMiddleware) c.header(correlationHeader, id);
      return c.newResponse(res.body, res);
    }

    const normalized = normalize(err);
    await report(err, c, normalized);
    const override = overrides[normalized.code];
    const status = override ?? (isErrorStatus(normalized.status) ? normalized.status : 500);
    if (format) {
      const { id, fromMiddleware } = correlationIdOf(c as Context);
      const res = await format(normalized, c, { status, correlationId: id, body: errorBody(normalized, id), original: err });
      return fromMiddleware || res.headers.has(correlationHeader) ? res : withHeader(res, correlationHeader, id);
    }
    return respondWithError(c as Context, normalized, status, correlationHeader);
  };
}
