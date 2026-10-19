import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from '@temporalio/client';

export interface PullHistoriesOptions {
  client: Client;
  workflowIds: readonly string[];
  /** Directory for `<workflowId>.json` files. */
  outDir: string;
}

/** A file name for a workflow ID: characters that are unsafe in file names become `_`. */
export function historyFileName(workflowId: string): string {
  return `${workflowId.replace(/[^\w.@=+-]/g, '_')}.json`;
}

/**
 * Downloads each workflow's event history (latest run) as JSON, the format
 * `Worker.runReplayHistory` and `historyFromJSON` accept, for replay tests.
 */
export async function pullHistories(options: PullHistoriesOptions): Promise<string[]> {
  const owners = new Map<string, string>();
  for (const id of options.workflowIds) {
    const name = historyFileName(id);
    const other = owners.get(name);
    if (other !== undefined) throw new Error(`Workflow IDs "${other}" and "${id}" both map to ${name}; pull them into different --out directories`);
    owners.set(name, id);
  }
  const { historyToJSON } = await import('@temporalio/common/lib/proto-utils.js');
  await mkdir(options.outDir, { recursive: true });
  const written: string[] = [];
  for (const id of options.workflowIds) {
    const history = await options.client.workflow.getHandle(id).fetchHistory();
    const file = join(options.outDir, historyFileName(id));
    await writeFile(file, `${historyToJSON(history)}\n`);
    written.push(file);
  }
  return written;
}
