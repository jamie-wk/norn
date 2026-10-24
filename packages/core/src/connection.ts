import { NornConfigError } from './errors.js';

/** Resolved Temporal connection settings. File reading for `clientCert` is left to the caller. */
export interface ConnectionSettings {
  address: string;
  namespace: string;
  apiKey: string | undefined;
  tls: boolean;
  /** mTLS client certificate and key file paths, from TEMPORAL_TLS_CERT / TEMPORAL_TLS_KEY. */
  clientCert: { certPath: string; keyPath: string } | undefined;
}

export interface ConnectionOverrides {
  address?: string;
  namespace?: string;
  apiKey?: string;
  tls?: boolean;
}

/**
 * Connection settings from options, then the environment: TEMPORAL_ADDRESS (localhost:7233),
 * TEMPORAL_NAMESPACE (default), TEMPORAL_API_KEY (turns TLS on), TEMPORAL_TLS, and
 * TEMPORAL_TLS_CERT / TEMPORAL_TLS_KEY for mTLS. Empty values count as unset, as `${VAR:-}` in
 * compose files produces them.
 */
export function connectionSettings(env: Readonly<Record<string, string | undefined>>, overrides: ConnectionOverrides = {}): ConnectionSettings {
  const certPath = env.TEMPORAL_TLS_CERT || undefined;
  const keyPath = env.TEMPORAL_TLS_KEY || undefined;
  if ((certPath === undefined) !== (keyPath === undefined)) {
    throw new NornConfigError('Set both TEMPORAL_TLS_CERT and TEMPORAL_TLS_KEY for mTLS, or neither');
  }
  const apiKey = overrides.apiKey || env.TEMPORAL_API_KEY || undefined;
  const clientCert = certPath && keyPath ? { certPath, keyPath } : undefined;
  return {
    address: overrides.address || env.TEMPORAL_ADDRESS || 'localhost:7233',
    namespace: overrides.namespace || env.TEMPORAL_NAMESPACE || 'default',
    apiKey,
    tls: overrides.tls ?? (apiKey !== undefined || clientCert !== undefined || env.TEMPORAL_TLS === 'true'),
    clientCert,
  };
}
