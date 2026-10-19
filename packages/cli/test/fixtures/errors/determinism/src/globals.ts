import { Workflow } from '@norn-ts/workflow';
import { Temporal as T } from 'temporal-polyfill';

function hoisted() {
  if (Math.random() > 2) {
    var process = { env: {} };
  }
  // oxlint-disable-next-line block-scoped-var
  return process?.env;
}

// oxlint-disable-next-line no-shadow
function shadowed(T: { Now: number }) {
  return T.Now;
}

@Workflow({ taskQueue: 'orders' })
export class GlobalsWorkflow {
  async run() {
    globalThis.setTimeout(() => {}, 1);
    const env = globalThis.process.env;
    const id = window.crypto.randomUUID();
    const t = self.performance.now();
    const i = global['setInterval'];
    const { Now } = Temporal;
    const n = globalThis.Temporal.Now.instant();
    const now = T.Now.instant();
    const fine = globalThis.Math.random();
    return [env, id, t, i, Now, n, now, fine, hoisted(), shadowed({ Now: 1 })];
  }
}
