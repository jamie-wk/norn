// An activity class used only for its type: workflows reference it through the registry below,
// exactly as `norn gen` would emit it.
export class PaymentActivities {
  async charge(orderId: string, cents: number): Promise<{ id: string; cents: number }> {
    return { id: `ch_${orderId}`, cents };
  }
  async refund(_chargeId: string): Promise<boolean> {
    return true;
  }
  async slow(ms: number): Promise<string> {
    return `slept ${ms}`;
  }
  async reject(): Promise<never> {
    throw new Error('declined');
  }
  async flaky(): Promise<number> {
    return 0;
  }
}
