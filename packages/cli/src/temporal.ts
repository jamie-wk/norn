import { readFileSync } from 'node:fs';
import type { Client } from '@temporalio/client';

export type Env = Record<string, string | undefined>;

export interface TemporalConnectionSettings {
  address: string;
  namespace: string;
  apiKey: string | undefined;
  tls: boolean | { clientCertPair: { crt: Buffer; key: Buffer } };
}

/**
 * Connection settings from the environment: TEMPORAL_ADDRESS (default localhost:7233),
 * TEMPORAL_NAMESPACE (default "default"), TEMPORAL_API_KEY (enables TLS), and optional
 * TEMPORAL_TLS_CERT / TEMPORAL_TLS_KEY file paths for mTLS.
 */
export function connectionSettings(env: Env): TemporalConnectionSettings {
  const cert = env.TEMPORAL_TLS_CERT;
  const key = env.TEMPORAL_TLS_KEY;
  if ((cert === undefined) !== (key === undefined)) {
    throw new Error('Set both TEMPORAL_TLS_CERT and TEMPORAL_TLS_KEY for mTLS, or neither');
  }
  const apiKey = env.TEMPORAL_API_KEY || undefined;
  return {
    address: env.TEMPORAL_ADDRESS || 'localhost:7233',
    namespace: env.TEMPORAL_NAMESPACE || 'default',
    apiKey,
    tls: cert && key ? { clientCertPair: { crt: readFileSync(cert), key: readFileSync(key) } } : apiKey !== undefined || env.TEMPORAL_TLS === 'true',
  };
}

export interface ConnectedClient {
  client: Client;
  namespace: string;
  close(): Promise<void>;
}

async function importClient(): Promise<typeof import('@temporalio/client')> {
  try {
    return await import('@temporalio/client');
  } catch (error) {
    throw new Error(`This command needs @temporalio/client. Install it next to @norn/cli. (${(error as Error).message})`, { cause: error });
  }
}

export async function connect(env: Env): Promise<ConnectedClient> {
  const settings = connectionSettings(env);
  const { Client, Connection } = await importClient();
  let connection;
  try {
    connection = await Connection.connect({ address: settings.address, tls: settings.tls, ...(settings.apiKey ? { apiKey: settings.apiKey } : {}) });
  } catch (error) {
    throw new Error(`Could not connect to Temporal at ${settings.address}: ${(error as Error).message}`, { cause: error });
  }
  const client = new Client({ connection, namespace: settings.namespace });
  return { client, namespace: settings.namespace, close: () => connection.close() };
}
