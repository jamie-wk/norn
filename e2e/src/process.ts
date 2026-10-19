import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 60_000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}${lastError ? `: ${String(lastError)}` : ''}`);
}

export async function httpOk(url: string): Promise<boolean> {
  const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  return res.ok;
}

/** A child process whose output is kept for failure messages. */
export class Proc {
  readonly output: string[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly child: ChildProcess;

  constructor(
    readonly name: string,
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string | undefined> },
  ) {
    this.child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (chunk: Buffer) => {
      this.output.push(chunk.toString());
      if (this.output.length > 400) this.output.shift();
      if (process.env.E2E_VERBOSE) process.stderr.write(`[${name}] ${chunk}`);
    };
    this.child.stdout!.on('data', keep);
    this.child.stderr!.on('data', keep);
    this.exited = once(this.child, 'exit').then(([code, signal]) => ({ code: code as number | null, signal: signal as NodeJS.Signals | null }));
  }

  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  logs(): string {
    return this.output.join('');
  }

  signal(signal: NodeJS.Signals): void {
    if (this.running) this.child.kill(signal);
  }

  /** SIGTERM, then SIGKILL after `graceMs`. */
  async stop(graceMs = 15_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (!this.running) return this.exited;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), graceMs);
    try {
      return await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
