import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleWorkflowCode, type BundleOptions } from '@temporalio/worker';
import { nornWebpackConfigHook, composeWebpackHooks } from './bundler.js';
import type { NornRegistry } from './registry.js';

const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

/** Absolute path of Norn's workflow interceptor module, for custom bundling setups. */
export const workflowInterceptorModule = fileURLToPath(new URL(`./workflow-interceptors${ext}`, import.meta.url));

export interface BundleWorkflowsOptions {
  /** Also write the bundle to this file, for `workflowBundle: { codePath }` in production. */
  outFile?: string;
  /** Required when workers use a custom payload converter, such as `createDataConverter()` from `@norn-ts/codec`. */
  payloadConverterPath?: string;
  /** Extra workflow interceptor modules. */
  workflowInterceptorModules?: string[];
  webpackConfigHook?: BundleOptions['webpackConfigHook'];
  plugins?: BundleOptions['plugins'];
  ignoreModules?: string[];
}

/**
 * Bundles the registry's workflows with Norn's settings: standard decorators, `.js`→`.ts`
 * resolution and the correlation interceptors. Run it at build time and ship the file.
 */
export async function bundleWorkflows(registry: Pick<NornRegistry, 'workflowsPath'>, options: BundleWorkflowsOptions = {}): Promise<{ code: string }> {
  const hook = nornWebpackConfigHook();
  const { code } = await bundleWorkflowCode({
    workflowsPath: registry.workflowsPath,
    workflowInterceptorModules: [workflowInterceptorModule, ...(options.workflowInterceptorModules ?? [])],
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
