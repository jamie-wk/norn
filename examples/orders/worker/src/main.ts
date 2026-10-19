import { createDataConverter } from '@norn/codec';
import { createWorker, installRuntime } from '@norn/worker';
import { registry } from '../.norn/registry.ts';

installRuntime();

// Encrypt payloads when keys are configured: NORN_ENCRYPTION_KEYS='{"k1":"<base64>"}', NORN_ENCRYPTION_KEY_ID=k1.
const keys = process.env.NORN_ENCRYPTION_KEYS ? (JSON.parse(process.env.NORN_ENCRYPTION_KEYS) as Record<string, string>) : undefined;
const dataConverter = keys ? createDataConverter({ keys, currentKeyId: process.env.NORN_ENCRYPTION_KEY_ID ?? Object.keys(keys)[0]! }) : undefined;

const worker = await createWorker({
  registry,
  dataConverter,
  // 4xx responses from the provider fail immediately; 5xx and timeouts are retried.
  container: { errors: { http: true } },
});
await worker.run();
