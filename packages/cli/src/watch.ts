import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { loadConfig } from './config.js';
import { NornGenFailure } from './errors.js';
import { generate, type GenerateOptions, type GenerateResult } from './generate.js';

export interface WatchOptions extends Omit<GenerateOptions, 'check' | 'write'> {
  /** Stops watching when aborted. */
  signal: AbortSignal;
  /** Quiet period after the last change before regenerating. Defaults to 100ms. */
  debounceMs?: number;
  /** Called after every generation, including the first. */
  onResult?: (result: GenerateResult) => void;
}

/**
 * Generates, then regenerates whenever a TypeScript file under the project root changes, until
 * `signal` aborts. Resolves once watching has stopped.
 */
export async function watch(options: WatchOptions): Promise<void> {
  const { signal, debounceMs = 100, onResult, ...genOptions } = options;
  if (signal.aborted) return;
  let root: string;
  let ignored: string[];
  try {
    const config = await loadConfig(genOptions);
    root = config.root;
    ignored = [config.outDir, join(root, 'node_modules'), ...(config.contractsOutFile ? [config.contractsOutFile] : [])];
  } catch (error) {
    if (!(error instanceof NornGenFailure)) throw error;
    onResult?.({ files: {}, written: [], stale: [], errors: error.errors });
    return;
  }

  let running: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  const run = () => {
    running = running.then(async () => {
      if (signal.aborted) return;
      const result = await generate(genOptions);
      if (!signal.aborted) onResult?.(result);
    });
    return running;
  };

  const isIgnored = (file: string) =>
    ignored.some((dir) => file === dir || file.startsWith(dir + sep)) || !/\.[cm]?tsx?$/.test(file) || relative(root, file).startsWith('..');

  await new Promise<void>((resolve) => {
    let watcher: FSWatcher | undefined;
    const stop = () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
      void running.finally(resolve);
    };
    watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
      if (!filename || signal.aborted) return;
      if (isIgnored(join(root, filename.toString()))) return;
      pending = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!pending) return;
        pending = false;
        void run();
      }, debounceMs);
    });
    watcher.on('error', stop);
    signal.addEventListener('abort', stop, { once: true });
    // Watch first, so edits made while the first generation runs are not missed.
    void run();
  });
}
