import { serve } from '@hono/node-server';
import { createClient } from '@norn/client';
import { clientDataConverter, createEncryptionCodec } from '@norn/codec';
import { createApp } from './app.ts';

const keys = process.env.NORN_ENCRYPTION_KEYS ? (JSON.parse(process.env.NORN_ENCRYPTION_KEYS) as Record<string, string>) : undefined;
const currentKeyId = process.env.NORN_ENCRYPTION_KEY_ID ?? Object.keys(keys ?? {})[0] ?? '';

const client = createClient({ dataConverter: keys ? clientDataConverter({ keys, currentKeyId }) : undefined });
const app = createApp({
  client,
  webhookSecret: process.env.WEBHOOK_SECRET ?? 'dev-secret',
  codec: keys && process.env.CODEC_TOKEN ? { codec: createEncryptionCodec({ keys, currentKeyId }), token: process.env.CODEC_TOKEN } : undefined,
});

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000), hostname: process.env.HOST ?? '0.0.0.0' }, (info) => {
  console.log(`orders api listening on http://localhost:${info.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(() => void client.close());
  });
}
