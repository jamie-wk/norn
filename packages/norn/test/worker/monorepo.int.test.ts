import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { createClient } from '../../src/client/index.ts';
import { createLocalEnv } from '../../../../tooling/test-support/temporal.ts';
import { createWorker } from '../../src/worker/index.ts';

// A pnpm-style monorepo outside this repo, so nothing is hoisted: the workflows package resolves
// only what its own node_modules links, as pnpm installs it.
//   packages/workflows  @acme/workflows: the @Workflow classes
//   apps/worker         activities + the worker (here: this test)
//   apps/api            the client (here: this test)
const norn = fileURLToPath(new URL('../..', import.meta.url));
let root: string;
let env: TestWorkflowEnvironment;

async function file(path: string, content: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
async function link(from: string, pkg: string, target: string) {
  await mkdir(dirname(join(root, from, 'node_modules', pkg)), { recursive: true });
  await symlink(target, join(root, from, 'node_modules', pkg), 'dir');
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'norn-monorepo-')));
  await file('packages/workflows/package.json', JSON.stringify({ name: '@acme/workflows', type: 'module', exports: './src/index.ts' }));
  await file('packages/workflows/src/index.ts', `export { QuoteWorkflow } from './quote.workflow.ts';\n`);
  await file(
    'packages/workflows/src/quote.workflow.ts',
    `import { Workflow, useActivities } from '@norn-ts/norn/workflow';
import type { PricingActivities } from '../../../apps/worker/src/pricing.activities.ts';

@Workflow({ taskQueue: 'mono-quotes', id: 'quote-{sku}' })
export class QuoteWorkflow {
  private readonly pricing = useActivities<PricingActivities>('pricing', { timeout: '10s' });
  async run(input: { sku: string }) {
    return \`\${input.sku}: \${await this.pricing.price(input.sku)}\`;
  }
}
`,
  );
  await file(
    'apps/worker/src/pricing.activities.ts',
    `export class PricingActivities {
  async price(sku: string) {
    return sku.length * 100;
  }
}
`,
  );
  // Only the workflows package's declared dependencies, linked as pnpm does.
  await link('packages/workflows', '@norn-ts/norn', norn);
  await link('packages/workflows', '@temporalio/workflow', await realpath(join(norn, 'node_modules/@temporalio/workflow')));
  env = await createLocalEnv();
});

afterAll(async () => {
  await env?.teardown();
  if (root) await rm(root, { recursive: true, force: true });
});

it('runs workflows from another workspace package, started by a client in a third', async () => {
  const { PricingActivities } = await import(pathToFileURL(join(root, 'apps/worker/src/pricing.activities.ts')).href);
  // A file:// string, as import.meta.resolve('@acme/workflows') returns it.
  const workflows = pathToFileURL(join(root, 'packages/workflows/src/index.ts')).href;
  const worker = await createWorker({
    workflows,
    activities: { pricing: new PricingActivities() },
    connection: env.nativeConnection,
    namespace: env.namespace ?? 'default',
    handleSignals: false,
  });
  const running = worker.run();
  try {
    const { QuoteWorkflow } = await import(workflows);
    const api = createClient({ connection: env.connection, namespace: env.namespace ?? 'default' });
    expect(await api.workflow(QuoteWorkflow).execute({ sku: `abc-${Date.now()}` })).toMatch(/^abc-\d+: \d+$/);
  } finally {
    await worker.shutdown();
    await running;
  }
});
