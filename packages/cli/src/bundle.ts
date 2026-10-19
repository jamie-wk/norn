import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface BundleOptions {
  /** The generated output directory (holding `workflows.ts` or `workflows.js`). */
  outDir: string;
  /** Where to write the bundle. */
  outFile: string;
  /** Include `@norn-ts/codec`'s payload converter (bigint and JS Temporal types). */
  codec?: boolean;
}

/** The generated workflows barrel: `.ts` from `norn gen`, or `.js` after compiling it. */
export function workflowsEntry(outDir: string): string | undefined {
  for (const name of ['workflows.ts', 'workflows.js']) {
    const file = join(outDir, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** Bundles the generated workflows with `bundleWorkflows()` from `@norn-ts/worker`. */
export async function bundle(options: BundleOptions): Promise<{ code: string; outFile: string; workflowsPath: string }> {
  const workflowsPath = workflowsEntry(options.outDir);
  if (!workflowsPath) throw new Error(`No workflows barrel in ${options.outDir}. Run norn gen first.`);
  let worker: typeof import('@norn-ts/worker');
  try {
    worker = await import('@norn-ts/worker');
  } catch (error) {
    throw new Error(`norn bundle needs @norn-ts/worker and @temporalio/worker. (${(error as Error).message})`, { cause: error });
  }
  let payloadConverterPath: string | undefined;
  if (options.codec) {
    try {
      payloadConverterPath = (await import('@norn-ts/codec')).resolvePayloadConverterPath();
    } catch (error) {
      throw new Error(`--codec needs @norn-ts/codec. (${(error as Error).message})`, { cause: error });
    }
  }
  const outFile = resolve(options.outFile);
  const { code } = await worker.bundleWorkflows({ workflowsPath }, { outFile, ...(payloadConverterPath ? { payloadConverterPath } : {}) });
  return { code, outFile, workflowsPath };
}
