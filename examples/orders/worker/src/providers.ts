import { provide } from '@norn/activity';
import { createClient } from '@norn/client';
import { TemporalClient } from './activities/loyalty.activities.ts';
import { AppConfig, loadConfig } from './services/config.ts';

/** Values the container can't build from a class: configuration and SDK clients. */
export const providers = [
  provide(AppConfig, () => loadConfig()),
  provide(TemporalClient, () => createClient(), { dispose: (client) => client.close() }),
];
