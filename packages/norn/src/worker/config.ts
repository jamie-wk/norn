import { NornConfigError, formatDuration, type Duration } from '../core/index.js';

export interface WorkerConfigOptions {
  /** Defaults to `TEMPORAL_ADDRESS`, then `localhost:7233`. */
  address?: string;
  /** Defaults to `TEMPORAL_NAMESPACE`, then `default`. */
  namespace?: string;
  /** Defaults to `TEMPORAL_API_KEY`; turns TLS on. */
  apiKey?: string;
  /** Defaults to `TEMPORAL_TLS=true`, or on when there is an API key. */
  tls?: boolean;
  /** How long in-flight activities may finish after shutdown starts. Default 30s. */
  shutdownGraceTime?: Duration;
  /** Shut down gracefully on SIGTERM and SIGINT. Default true. */
  handleSignals?: boolean;
}

export interface ResolvedWorkerConfig {
  address: string;
  namespace: string;
  apiKey: string | undefined;
  tls: boolean;
  shutdownGraceTime: `${number}ms`;
  handleSignals: boolean;
}

/** Resolves worker settings from options, then `TEMPORAL_*` environment variables, then defaults. Empty variables count as unset. */
export function resolveWorkerConfig(options: WorkerConfigOptions, env: Record<string, string | undefined> = process.env): ResolvedWorkerConfig {
  const apiKey = options.apiKey ?? (env.TEMPORAL_API_KEY || undefined);
  let shutdownGraceTime: `${number}ms`;
  try {
    shutdownGraceTime = formatDuration(options.shutdownGraceTime ?? '30s');
  } catch (error) {
    throw new NornConfigError(`shutdownGraceTime: ${(error as Error).message}`, { cause: error });
  }
  return {
    address: options.address ?? (env.TEMPORAL_ADDRESS || 'localhost:7233'),
    namespace: options.namespace ?? (env.TEMPORAL_NAMESPACE || 'default'),
    apiKey,
    tls: options.tls ?? (apiKey !== undefined || env.TEMPORAL_TLS === 'true'),
    shutdownGraceTime,
    handleSignals: options.handleSignals ?? true,
  };
}
