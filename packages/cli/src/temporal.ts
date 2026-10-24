import { readFileSync } from 'node:fs';
import type { Client } from '@temporalio/client';
import { connectionSettings as resolveConnection } from '@norn-ts/core';

export type Env = Record<string, string | undefined>;

export interface TemporalConnectionSettings {
  address: string;
  namespace: string;
  apiKey: string | undefined;
  tls: boolean | { clientCertPair: { crt: Buffer; key: Buffer } };
}

/** Connection settings from the environment (see `connectionSettings()` in @norn-ts/core), with mTLS files read. */
export function connectionSettings(env: Env): TemporalConnectionSettings {
  const { address, namespace, apiKey, tls, clientCert } = resolveConnection(env);
  return {
    address,
    namespace,
    apiKey,
    tls: clientCert ? { clientCertPair: { crt: readFileSync(clientCert.certPath), key: readFileSync(clientCert.keyPath) } } : tls,
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
    throw new Error(`This command needs @temporalio/client. Install it next to @norn-ts/cli. (${(error as Error).message})`, { cause: error });
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
