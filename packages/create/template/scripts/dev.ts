// pnpm dev: a local Temporal server (unless one is already running) and the worker, restarted
// whenever you change a file. Ctrl+C stops everything.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { TestWorkflowEnvironment } from '@temporalio/testing';

const run = (command: string, args: string[]): ChildProcess =>
  // shell on Windows so the node_modules/.bin .cmd shims resolve
  spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, 'localhost');
    socket.setTimeout(500);
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
  });

let temporal: TestWorkflowEnvironment | undefined;
if (process.env.TEMPORAL_ADDRESS) {
  console.log(`Using the Temporal server at ${process.env.TEMPORAL_ADDRESS}.`);
} else if (await listening(7233)) {
  console.log('Using the Temporal server already running on localhost:7233.');
} else {
  console.log('Starting a local Temporal server (the first run downloads it)...');
  // Workflows are kept in .temporal/ between runs, so a restart picks up where you left off.
  mkdirSync('.temporal', { recursive: true });
  temporal = await TestWorkflowEnvironment.createLocal({
    server: { ip: 'localhost', port: 7233, uiPort: 8233, dbFilename: '.temporal/dev.db' },
  });
  console.log('Temporal is running on localhost:7233. Web UI: http://localhost:8233');
}

const children = [run('tsx', ['watch', '--clear-screen=false', 'src/worker.ts'])];

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map((child) => (child.exitCode === null ? new Promise((r) => child.once('close', r)) : undefined)));
  await temporal?.teardown();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
