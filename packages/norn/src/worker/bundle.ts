import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { bundleWorkflowCode, type BundleOptions } from '@temporalio/worker';
import { nornWebpackConfigHook, composeWebpackHooks } from './bundler.js';
import { loadWorkflows, writeEntry } from './load.js';

export interface BundleWorkflowsOptions {
  /** Also write the bundle to this file, for `createWorker({ workflowBundle: { codePath } })` in production. */
  outFile?: string;
  /** Required when workers use a custom payload converter. */
  payloadConverterPath?: string;
  workflowInterceptorModules?: string[];
  webpackConfigHook?: BundleOptions['webpackConfigHook'];
  plugins?: BundleOptions['plugins'];
  ignoreModules?: string[];
}

/**
 * Bundles the `@Workflow` classes a module exports, with standard decorators and `.js`→`.ts`
 * resolution. `createWorker()` does this at startup; run it at build time to ship the bundle instead.
 */
export async function bundleWorkflows(workflows: string | URL, options: BundleWorkflowsOptions = {}): Promise<{ code: string }> {
  return bundleEntry(await writeEntry((await loadWorkflows(workflows)).path), options);
}

/** @internal Bundles a module as is, e.g. an entry from `writeEntry()`, resolving packages from `nodeModules`. */
export async function bundleEntry(
  { workflowsPath, nodeModules }: { workflowsPath: string; nodeModules: string },
  options: BundleWorkflowsOptions = {},
): Promise<{ code: string }> {
  const hook = nornWebpackConfigHook({ modules: [nodeModules] });
  const { code } = await bundleWorkflowCode({
    workflowsPath,
    workflowInterceptorModules: options.workflowInterceptorModules,
    payloadConverterPath: options.payloadConverterPath,
    ignoreModules: options.ignoreModules,
    plugins: options.plugins,
    webpackConfigHook: (options.webpackConfigHook ? composeWebpackHooks(hook as never, options.webpackConfigHook as never) : hook) as never,
  });
  if (options.outFile) {
    await mkdir(dirname(options.outFile), { recursive: true });
    await writeFile(options.outFile, code);
  }
  return { code };
}
