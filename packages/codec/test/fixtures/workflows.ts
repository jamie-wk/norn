// Plain Temporal workflows for the codec integration test.

export interface Invoice {
  customer: string;
  cents: bigint;
}

/** Doubles a bigint inside the workflow, proving the payload converter runs in the sandbox. */
export async function doubleInvoice(invoice: Invoice): Promise<Invoice & { doubled: bigint }> {
  return { ...invoice, doubled: invoice.cents * 2n };
}
