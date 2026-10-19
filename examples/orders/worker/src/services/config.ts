import { token } from '@norn-ts/activity';

export interface AppConfig {
  /** Base URL of the payment/shipping/email provider. */
  providerUrl: string;
  /** Request timeout for provider calls, in milliseconds. */
  httpTimeoutMs: number;
}
export const AppConfig = token<AppConfig>('AppConfig');

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    providerUrl: env.PROVIDER_URL ?? 'http://localhost:4010',
    httpTimeoutMs: Number(env.PROVIDER_TIMEOUT_MS ?? 10_000),
  };
}
