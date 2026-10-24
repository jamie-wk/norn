import { createWorker } from '@norn-ts/worker';
import { registry } from '../.norn/registry';

// Connects to TEMPORAL_ADDRESS (default localhost:7233) and runs every workflow and activity in the registry.
const worker = await createWorker({ registry });
console.log('Worker running. Press Ctrl+C to stop.');
// Runs until SIGINT / SIGTERM, then finishes in-flight work.
await worker.run();
