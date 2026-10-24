#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { main } from './index.js';

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

process.exitCode = await main(process.argv.slice(2), { prompt: process.stdin.isTTY ? prompt : undefined });
