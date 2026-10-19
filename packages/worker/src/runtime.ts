import { DefaultLogger, Runtime, makeTelemetryFilterString, type LogLevel } from '@temporalio/worker';
import { NornConfigError } from '@norn/core';

export interface InstallRuntimeOptions {
  /** Serve Prometheus metrics for the SDK and Temporal core on this address, e.g. `'0.0.0.0:9464'` or `'[::]:9464'`. Defaults to `NORN_METRICS_ADDRESS`. */
  metricsAddress?: string;
  /** Defaults to `NORN_LOG_LEVEL`, then `INFO`. */
  logLevel?: LogLevel;
}

const LEVELS: readonly LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];

/**
 * Installs the Temporal runtime with Prometheus metrics and a log level. Call it once at process
 * start, before creating a connection or worker.
 */
export function installRuntime(options: InstallRuntimeOptions = {}, env: Record<string, string | undefined> = process.env): Runtime {
  const level = (options.logLevel ?? (env.NORN_LOG_LEVEL || 'INFO')).toUpperCase() as LogLevel;
  if (!LEVELS.includes(level)) throw new NornConfigError(`Log level must be one of ${LEVELS.join(', ')}, got ${level}`);
  const metricsAddress = options.metricsAddress ?? (env.NORN_METRICS_ADDRESS || undefined);
  if (metricsAddress !== undefined && !/^(\[[^\]]+\]|[^:]+):\d+$/.test(metricsAddress)) {
    throw new NornConfigError(`Metrics address must look like host:port or [ipv6]:port, got ${metricsAddress}`);
  }
  try {
    return Runtime.install({
      logger: new DefaultLogger(level),
      telemetryOptions: {
        logging: { filter: makeTelemetryFilterString({ core: level === 'TRACE' ? 'TRACE' : 'WARN' }), forward: {} },
        ...(metricsAddress ? { metrics: { prometheus: { bindAddress: metricsAddress } } } : {}),
      },
    });
  } catch (error) {
    throw new NornConfigError(
      `installRuntime() failed: ${(error as Error).message} (it must run once, before any Temporal connection or worker is created)`,
      { cause: error },
    );
  }
}
