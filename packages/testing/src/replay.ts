import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { historyFromJSON } from '@temporalio/common/lib/proto-utils.js';
import { Worker, type ReplayWorkerOptions } from '@temporalio/worker';
import { NornConfigError } from '@norn/core';
import type { NornRegistry } from '@norn/worker';
import { cachedBundle } from './env.js';

export interface RecordedHistory {
  workflowId: string;
  history: unknown;
}

/**
 * Loads histories saved by `norn histories pull` (one `<workflowId>.json` per execution, or
 * `{ workflowId, history }` objects) from a directory.
 */
export async function loadHistories(dir: string): Promise<RecordedHistory[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).toSorted();
  const out: RecordedHistory[] = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new NornConfigError(`${file} is not valid JSON: ${(error as Error).message}`, { cause: error });
    }
    const wrapped = data as { workflowId?: unknown; history?: unknown };
    const raw = wrapped.history !== undefined ? wrapped.history : data;
    out.push({
      workflowId: typeof wrapped.workflowId === 'string' ? wrapped.workflowId : basename(file, '.json'),
      history: historyFromJSON(raw),
    });
  }
  return out;
}

export interface ReplayOptions {
  /** The registry whose workflows must replay the histories. */
  registry?: Pick<NornRegistry, 'workflowsPath'>;
  /** Or a workflows module path directly. */
  workflowsPath?: string;
  dataConverter?: ReplayWorkerOptions['dataConverter'];
}

/**
 * Replays recorded histories against the current workflow code and throws if any of them would
 * hit a non-determinism error. Run it in CI before deploying workflow changes.
 */
export async function assertReplays(histories: readonly RecordedHistory[], options: ReplayOptions): Promise<{ replayed: number }> {
  if (histories.length === 0) throw new NornConfigError('No histories to replay; record some with `norn histories pull`');
  const workflowsPath = options.workflowsPath ?? options.registry?.workflowsPath;
  if (!workflowsPath) throw new NornConfigError('assertReplays() needs a registry or workflowsPath');
  const payloadConverterPath = (options.dataConverter as { payloadConverterPath?: string } | undefined)?.payloadConverterPath;
  const workflowBundle = await cachedBundle(workflowsPath, payloadConverterPath);
  const failures: string[] = [];
  let replayed = 0;
  for await (const result of Worker.runReplayHistories(
    { workflowBundle, dataConverter: options.dataConverter, replayName: 'norn-replay' },
    histories.map((h) => ({ workflowId: h.workflowId, history: h.history as never })),
  )) {
    replayed++;
    if (result.error) failures.push(`- ${result.workflowId}: ${result.error.message}`);
  }
  if (failures.length) {
    throw new Error(`${failures.length} of ${replayed} histories failed to replay:\n${failures.join('\n')}`);
  }
  return { replayed };
}
