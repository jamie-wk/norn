import { describe, expect, it } from 'vitest';
import { NornConfigError } from '../../src/core/index.ts';
import { createClient } from '../../src/client/index.ts';
import { OrderWorkflow } from './fixtures/workflow-classes.ts';

describe('handler names', () => {
  // The connection is lazy, so these fail before anything is sent.
  const order = createClient({ address: '127.0.0.1:1' }).workflow(OrderWorkflow).get({ orderId: 'o-1' }) as unknown as Record<'signal' | 'query' | 'update', (name: string) => Promise<unknown>>;

  it('rejects a method used as the wrong kind of handler, before calling the server', async () => {
    await expect(order.signal('getItems')).rejects.toThrow(new NornConfigError('OrderWorkflow has no @Signal method "getItems"'));
    await expect(order.query('cancel')).rejects.toThrow(/no @Query method "cancel"/);
    await expect(order.update('close')).rejects.toThrow(/no @Update method "close"/);
  });
});
