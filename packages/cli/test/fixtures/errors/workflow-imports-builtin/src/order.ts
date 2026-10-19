import { readFileSync } from 'node:fs';
import path from 'path';
import { Client } from '@temporalio/client';
import { provide } from '@norn/activity';
import { createWorker } from '@norn/worker/sub/path';
import { sleep } from '@temporalio/workflow';
import { Workflow } from '@norn/workflow';
export { Context } from '@temporalio/activity';

@Workflow({ taskQueue: 'orders' })
export class OrderWorkflow {
  async run() {
    await sleep(1);
    const mod = await import('node:crypto');
    return [readFileSync, path, Client, provide, createWorker, mod];
  }
}
