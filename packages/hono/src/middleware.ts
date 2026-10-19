import type { Context, MiddlewareHandler } from 'hono';
import { createClient, runWithCorrelationId, type ClientOptions, type NornClient } from '@norn-ts/client';
import { NornConfigError } from '@norn-ts/core';
import { DEFAULT_CORRELATION_HEADER, isHeaderName, isValidCorrelationId, withHeader } from './internal.js';

/** Context variables set by {@link temporal}. */
export interface NornVariables {
  /** The Norn client: `c.var.norn.workflow(Orders).start(...)`. */
  norn: NornClient;
  /** The correlation ID of this request, also returned in the correlation response header. */
  correlationId: string;
}

/** Hono env for apps using {@link temporal}: `new Hono<NornEnv>()`. */
export type NornEnv = { Variables: NornVariables };

export interface CorrelationOptions {
  /**
   * Request header read for an incoming correlation ID, and response header the ID is echoed in.
   * Default `x-correlation-id`.
   */
  correlationHeader?: string;
  /** Fallback request header for an incoming ID; `false` disables it. Default `x-request-id`. */
  requestIdHeader?: string | false;
  /**
   * Accept correlation IDs sent by clients (after validation). Default true. Set to false on
   * public APIs where callers should not be able to choose the ID that ends up in your logs.
   */
  trustIncoming?: boolean;
}

/** Options for {@link temporal}: an existing client, or options to create one. */
export type TemporalOptions = ({ client: NornClient } | (ClientOptions & { client?: undefined })) & CorrelationOptions;

/** The middleware returned by {@link temporal}. */
export interface TemporalMiddleware extends MiddlewareHandler<NornEnv> {
  /** The client the middleware uses. When it was created from options, accessing this creates it. */
  readonly client: NornClient;
  /**
   * Closes the client if this middleware created it (call on shutdown). Does nothing for a
   * client you passed in, or when no request has created the client yet.
   */
  close(): Promise<void>;
}

function correlationOptions(options: CorrelationOptions) {
  const header = options.correlationHeader ?? DEFAULT_CORRELATION_HEADER;
  if (!isHeaderName(header)) throw new NornConfigError(`correlationHeader must be a valid header name, got ${JSON.stringify(header)}`);
  const requestIdHeader = options.requestIdHeader ?? 'x-request-id';
  if (requestIdHeader !== false && !isHeaderName(requestIdHeader)) {
    throw new NornConfigError(`requestIdHeader must be a valid header name or false, got ${JSON.stringify(requestIdHeader)}`);
  }
  if (options.trustIncoming !== undefined && typeof options.trustIncoming !== 'boolean') {
    throw new NornConfigError('trustIncoming must be a boolean');
  }
  return { header: header.toLowerCase(), requestIdHeader: requestIdHeader === false ? undefined : requestIdHeader.toLowerCase(), trust: options.trustIncoming ?? true };
}

/**
 * Picks the correlation ID for a request: the correlation header, then the request-id header,
 * then hono's `requestId()` variable, each only if valid (1–128 chars of `[A-Za-z0-9._:-]`),
 * else a fresh UUID.
 */
function resolveCorrelationId(c: Context, opts: ReturnType<typeof correlationOptions>): string {
  if (opts.trust) {
    const candidates = [c.req.header(opts.header), opts.requestIdHeader ? c.req.header(opts.requestIdHeader) : undefined, (c.var as Record<string, unknown>).requestId];
    for (const candidate of candidates) if (isValidCorrelationId(candidate)) return candidate;
  }
  return globalThis.crypto.randomUUID();
}

function isNornClient(value: unknown): value is NornClient {
  return typeof value === 'object' && value !== null && typeof (value as { workflow?: unknown }).workflow === 'function';
}

/**
 * Hono middleware that puts a Norn client on the context (`c.var.norn`) and runs the rest of the
 * request with a correlation ID, so workflows started, signalled, queried or updated while
 * handling it carry the ID (header `norn-correlation-id`) into workflows, activities and logs.
 *
 * The ID comes from the `x-correlation-id` request header, else `x-request-id`, else hono's
 * `requestId()` middleware, else a new UUID; invalid incoming IDs are replaced. It is available
 * as `c.var.correlationId` and `getCorrelationId()`, and echoed in the `x-correlation-id`
 * response header.
 *
 * @example
 * ```ts
 * const app = new Hono<NornEnv>();
 * app.use(temporal({ address: process.env.TEMPORAL_ADDRESS }));
 * app.post('/orders', async (c) => {
 *   const handle = await c.var.norn.workflow(Orders).start(await c.req.json());
 *   return c.json({ workflowId: handle.workflowId }, 201);
 * });
 * ```
 */
export function temporal(options: TemporalOptions): TemporalMiddleware {
  if (typeof options !== 'object' || options === null) {
    throw new NornConfigError('temporal() expects { client } or client options');
  }
  const { client: given, correlationHeader, requestIdHeader, trustIncoming, ...clientOptions } = options;
  if (given !== undefined && !isNornClient(given)) {
    throw new NornConfigError('temporal({ client }) expects a client from createClient()');
  }
  const opts = correlationOptions({ correlationHeader, requestIdHeader, trustIncoming });

  let created: NornClient | undefined;
  const getClient = (): NornClient => given ?? (created ??= createClient(clientOptions as ClientOptions));

  const middleware: MiddlewareHandler<NornEnv> = async (c, next) => {
    const id = resolveCorrelationId(c, opts);
    c.set('norn', getClient());
    c.set('correlationId', id);
    await runWithCorrelationId(id, next);
    if (!c.res.headers.has(opts.header)) {
      const res = withHeader(c.res, opts.header, id);
      if (res !== c.res) c.res = res;
    }
  };

  return Object.defineProperties(middleware, {
    client: { get: getClient, enumerable: true },
    close: {
      value: async () => {
        const client = created;
        created = undefined;
        await client?.close();
      },
    },
  }) as TemporalMiddleware;
}
