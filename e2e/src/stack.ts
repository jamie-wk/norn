/**
 * Starts the orders example as real processes: a Temporal dev server, the payment provider stub,
 * the compiled worker and the API. With E2E_TARGET=compose, talks to the Docker Compose stack in
 * e2e/docker-compose.yml instead.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client, Connection } from '@temporalio/client';
import { startProvider, type Provider, type RecordedCall, type Script } from '@norn/example-orders-provider';
import { Proc, freePort, httpOk, waitFor } from './process.ts';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const paths = {
  root,
  worker: join(root, 'examples/orders/worker'),
  api: join(root, 'examples/orders/api'),
  compose: join(root, 'e2e/docker-compose.yml'),
};

export const WEBHOOK_SECRET = 'e2e-webhook-secret';
export const CODEC_TOKEN = 'e2e-codec-token';

export interface StackOptions {
  /** Encrypt payloads: `{ keyId: base64Key }`. */
  encryptionKeys?: Record<string, string>;
  /** Extra worker environment, e.g. NORN_DEPLOYMENT_NAME / NORN_BUILD_ID. */
  workerEnv?: Record<string, string>;
  /** Start without a worker (start it later with `stack.worker.start()`). */
  startWorker?: boolean;
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface WorkerControl {
  start(env?: Record<string, string>): Promise<void>;
  /** Graceful stop (SIGTERM) and wait for exit. */
  stop(): Promise<{ code: number | null; signal: string | null }>;
  /** Sends SIGTERM without waiting. */
  terminate(): void;
  readonly running: boolean;
  readyz(): Promise<number>;
  logs(): string;
}

export interface Stack {
  readonly apiUrl: string;
  readonly temporalAddress: string;
  readonly namespace: string;
  readonly temporal: Client;
  readonly worker: WorkerControl;
  api<T = any>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<ApiResponse<T>>;
  providerCalls(route?: RecordedCall['route']): Promise<RecordedCall[]>;
  script(script: Script): Promise<void>;
  sendWebhook(event: unknown, secret?: string): Promise<{ status: number; body: any }>;
  /** Runs the `temporal` CLI against this stack's server. */
  temporalCli(args: string[]): Promise<string>;
  teardown(): Promise<void>;
}

export function temporalCliPath(): string {
  return process.env.NORN_TEMPORAL_CLI_PATH ?? 'temporal';
}

function checkBuilt(): void {
  const required = [join(paths.worker, 'dist/src/main.js'), join(paths.worker, 'dist/workflow-bundle.js'), join(root, 'packages/hono/dist/index.js')];
  const missing = required.filter((f) => !existsSync(f));
  if (missing.length) {
    throw new Error(`e2e needs built packages and the built example worker; run \`pnpm e2e:build\` first. Missing:\n${missing.join('\n')}`);
  }
}

async function api(baseUrl: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResponse> {
  const res = await fetch(new URL(path, baseUrl), {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON; keep the text.
  }
  return { status: res.status, body, headers: res.headers };
}

export async function startStack(options: StackOptions = {}): Promise<Stack> {
  return process.env.E2E_TARGET === 'compose' ? composeStack() : processStack(options);
}

async function processStack(options: StackOptions): Promise<Stack> {
  checkBuilt();
  const cleanups: Array<() => Promise<unknown>> = [];
  const teardown = async () => {
    for (const fn of cleanups.splice(0).toReversed()) await fn().catch(() => undefined);
  };

  try {
    const [temporalPort, apiPort, healthPort] = await Promise.all([freePort(), freePort(), freePort()]);
    const temporalAddress = `127.0.0.1:${temporalPort}`;
    const dir = await mkdtemp(join(tmpdir(), 'norn-e2e-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const server = new Proc(
      'temporal',
      temporalCliPath(),
      [
        'server', 'start-dev',
        '--ip', '127.0.0.1',
        '--port', String(temporalPort),
        '--headless',
        '--log-level', 'error',
        '--db-filename', join(dir, 'temporal.db'),
        '--search-attribute', 'CustomerId=Keyword',
        '--search-attribute', 'OrderStatus=Keyword',
        '--dynamic-config-value', 'frontend.workerVersioningWorkflowAPIs=true',
        '--dynamic-config-value', 'system.enableDeploymentVersions=true',
      ],
      { cwd: dir, env: {} },
    );
    cleanups.push(() => server.stop(5_000));

    const connection = await (async () => {
      let conn: Connection | undefined;
      await waitFor('Temporal dev server', async () => {
        conn = await Connection.connect({ address: temporalAddress, connectTimeout: '1s' });
        await conn.healthService.check({});
        return true;
      }, 60_000, 300).catch((error: Error) => {
        throw new Error(`${error.message}\n${server.logs()}`);
      });
      return conn!;
    })();
    cleanups.push(() => connection.close());
    const temporal = new Client({ connection, namespace: 'default' });

    const provider: Provider = await startProvider();
    cleanups.push(() => provider.close());

    const keysEnv: Record<string, string> = options.encryptionKeys
      ? { NORN_ENCRYPTION_KEYS: JSON.stringify(options.encryptionKeys), NORN_ENCRYPTION_KEY_ID: Object.keys(options.encryptionKeys)[0]! }
      : {};
    const common = { TEMPORAL_ADDRESS: temporalAddress, TEMPORAL_NAMESPACE: 'default', ...keysEnv };

    let workerProc: Proc | undefined;
    const worker: WorkerControl = {
      async start(env = {}) {
        if (workerProc?.running) throw new Error('worker is already running');
        workerProc = new Proc('worker', process.execPath, ['dist/src/main.js'], {
          cwd: paths.worker,
          env: {
            ...common,
            PROVIDER_URL: provider.url,
            NORN_HEALTH_PORT: String(healthPort),
            NORN_WORKFLOW_BUNDLE: join(paths.worker, 'dist/workflow-bundle.js'),
            NORN_SHUTDOWN_GRACE: '20s',
            NORN_LOG_LEVEL: 'WARN',
            ...options.workerEnv,
            ...env,
          },
        });
        const proc = workerProc;
        await waitFor('worker readiness', async () => {
          if (!proc.running) throw new Error(`worker exited:\n${proc.logs()}`);
          return httpOk(`http://127.0.0.1:${healthPort}/readyz`);
        }, 60_000).catch((error: Error) => {
          throw new Error(`${error.message}\n${proc.logs()}`);
        });
      },
      async stop() {
        return workerProc ? workerProc.stop(30_000) : { code: 0, signal: null };
      },
      terminate() {
        workerProc?.signal('SIGTERM');
      },
      get running() {
        return workerProc?.running ?? false;
      },
      async readyz() {
        return (await fetch(`http://127.0.0.1:${healthPort}/readyz`, { signal: AbortSignal.timeout(2_000) })).status;
      },
      logs: () => workerProc?.logs() ?? '',
    };
    cleanups.push(() => worker.stop());

    const apiProc = new Proc('api', process.execPath, ['src/main.ts'], {
      cwd: paths.api,
      env: { ...common, PORT: String(apiPort), HOST: '127.0.0.1', WEBHOOK_SECRET, ...(options.encryptionKeys ? { CODEC_TOKEN } : {}) },
    });
    cleanups.push(() => apiProc.stop(5_000));
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    await waitFor('API', async () => {
      if (!apiProc.running) throw new Error(`api exited:\n${apiProc.logs()}`);
      return httpOk(`${apiUrl}/healthz`);
    }).catch((error: Error) => {
      throw new Error(`${error.message}\n${apiProc.logs()}`);
    });

    if (options.startWorker !== false) await worker.start();

    return {
      apiUrl,
      temporalAddress,
      namespace: 'default',
      temporal,
      worker,
      api: (path, init) => api(apiUrl, path, init),
      providerCalls: async (route) => (route ? provider.calls.filter((c) => c.route === route) : [...provider.calls]),
      script: async (script) => {
        const res = await fetch(`${provider.url}/__script`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(script) });
        if (!res.ok) throw new Error(`script failed: ${res.status}`);
      },
      sendWebhook: async (event, secret = WEBHOOK_SECRET) => {
        const res = await fetch(`${provider.url}/__webhooks/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: `${apiUrl}/webhooks/payments`, secret, event }),
        });
        return (await res.json()) as { status: number; body: any };
      },
      temporalCli: async (args) => (await exec(temporalCliPath(), [...args, '--address', temporalAddress, '--namespace', 'default'])).stdout,
      teardown,
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}

/** The Docker Compose stack: `docker compose -f e2e/docker-compose.yml up -d --build --wait` first. */
async function composeStack(): Promise<Stack> {
  const apiUrl = process.env.E2E_API_URL ?? 'http://localhost:3000';
  const providerUrl = process.env.E2E_PROVIDER_URL ?? 'http://localhost:4010';
  const temporalAddress = process.env.E2E_TEMPORAL_ADDRESS ?? 'localhost:7233';
  const healthUrl = process.env.E2E_WORKER_HEALTH_URL ?? 'http://localhost:8081';
  const compose = (...args: string[]) => exec('docker', ['compose', '-f', paths.compose, ...args]);
  const connection = await Connection.connect({ address: temporalAddress });
  const temporal = new Client({ connection, namespace: 'default' });
  await fetch(`${providerUrl}/__reset`, { method: 'POST' });

  const worker: WorkerControl = {
    async start(env = {}) {
      if (Object.keys(env).length) throw new Error('compose mode cannot change worker environment per test');
      await compose('start', 'worker');
      await waitFor('worker readiness', () => httpOk(`${healthUrl}/readyz`), 120_000);
    },
    async stop() {
      await compose('stop', '--timeout', '30', 'worker');
      const { stdout } = await compose('ps', '-a', '--format', 'json', 'worker');
      return { code: (JSON.parse(stdout.split('\n')[0]!) as { ExitCode: number }).ExitCode, signal: null };
    },
    terminate() {
      void compose('kill', '-s', 'SIGTERM', 'worker');
    },
    get running() {
      return true;
    },
    async readyz() {
      return (await fetch(`${healthUrl}/readyz`)).status;
    },
    logs: () => '',
  };
  return {
    apiUrl,
    temporalAddress,
    namespace: 'default',
    temporal,
    worker,
    api: (path, init) => api(apiUrl, path, init),
    providerCalls: async (route) => (await (await fetch(`${providerUrl}/__calls${route ? `?route=${route}` : ''}`)).json()) as RecordedCall[],
    script: async (script) => void (await fetch(`${providerUrl}/__script`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(script) })),
    sendWebhook: async (event, secret = WEBHOOK_SECRET) =>
      (await (
        await fetch(`${providerUrl}/__webhooks/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: `${process.env.E2E_API_URL_FROM_PROVIDER ?? 'http://api:3000'}/webhooks/payments`, secret, event }),
        })
      ).json()) as { status: number; body: any },
    temporalCli: async () => {
      throw new Error('temporalCli is not available with E2E_TARGET=compose; run this test against the process stack');
    },
    teardown: async () => {
      await connection.close();
    },
  };
}
