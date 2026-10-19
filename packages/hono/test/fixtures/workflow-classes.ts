import { condition } from '@temporalio/workflow';
import { Query, Signal, Update, Validate, Workflow } from '@norn/workflow';

export class InvalidNoteError extends Error {
  override name = 'InvalidNoteError';
}

export interface PaymentInput {
  paymentId: string;
  amountCents: number;
}

@Workflow({ taskQueue: 'hono-tests', id: 'hono-payment-{paymentId}' })
export class HonoPaymentWorkflow {
  private status: 'pending' | 'paid' = 'pending';
  private paidCents = 0;
  private readonly notes: string[] = [];

  @Signal() paid(amountCents: number) {
    this.paidCents += amountCents;
    this.status = 'paid';
  }

  @Validate('addNote') checkNote(note: string) {
    if (!note.trim()) throw new InvalidNoteError('note must not be empty');
  }

  @Update() addNote(note: string) {
    this.notes.push(note);
    return this.notes.length;
  }

  @Query() summary() {
    return { status: this.status, paidCents: this.paidCents, notes: [...this.notes] };
  }

  async run(input: PaymentInput) {
    await condition(() => this.status === 'paid');
    return { paymentId: input.paymentId, paidCents: this.paidCents, notes: [...this.notes] };
  }
}
