import { createWorker } from '@norn-ts/worker';
import { PaymentActivities } from './activities/payment.activities';
import { FakePaymentGateway } from './services/payment-gateway';

// Connects to TEMPORAL_ADDRESS (default localhost:7233) and runs these workflows and activities.
const worker = await createWorker({
  workflows: new URL('./workflows/index.ts', import.meta.url),
  activities: { payments: new PaymentActivities(new FakePaymentGateway()) },
});
console.log('Worker running. Press Ctrl+C to stop.');
// Runs until SIGINT / SIGTERM, then finishes in-flight work.
await worker.run();
