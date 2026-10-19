import { readFileSync } from 'node:fs';
import path from 'path';
import { Client } from '@temporalio/client';
import { provide } from '@norn-ts/activity';
import { createWorker } from '@norn-ts/worker/sub/path';
import { sleep } from '@temporalio/workflow';
import { Workflow } from '@norn-ts/workflow';
export { Context } from '@temporalio/activity';
import { Buffer } from 'buffer/';
import punycode from 'punycode/punycode.js';

@Workflow({ taskQueue: 'orders' })
export class OrderWorkflow {
  async run() {
    await sleep(1);
    const mod = await import('node:crypto');
    return [readFileSync, path, Client, provide, createWorker, mod, Buffer, punycode];
  }
}
