// pnpm order               starts an order
// pnpm order cancel <id>   cancels it (and refunds it) within the cancellation window
// pnpm order status <id>   asks a running order for its status
import { createClient } from '@norn-ts/client';
import { OrderWorkflow } from '../.norn/contracts.js';

const [command = 'start', id] = process.argv.slice(2);
// TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE and TEMPORAL_API_KEY configure the connection.
await using norn = createClient();
const orders = norn.workflow(OrderWorkflow);

if (command === 'start') {
  const orderId = id ?? `o-${Date.now().toString(36)}`;
  const order = await orders.start({ orderId, cents: 1999 });
  console.log(`Started ${order.workflowId}: http://localhost:8233/namespaces/default/workflows/${order.workflowId}`);
  console.log(`Cancel it within 5 minutes with: pnpm order cancel ${orderId}`);
} else if ((command === 'cancel' || command === 'status') && id) {
  const order = orders.get({ orderId: id });
  if (command === 'cancel') {
    await order.signal('cancel', 'customer request');
    console.log(`Canceled ${id}.`);
  } else {
    console.log(await order.query('getStatus'));
  }
} else {
  console.error('Usage: pnpm order [start [id] | cancel <id> | status <id>]');
  process.exitCode = 2;
}
