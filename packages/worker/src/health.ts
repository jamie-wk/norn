import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Readiness = boolean | { ready: boolean; details?: Record<string, unknown> };

export interface HealthServerOptions {
  port: number;
  host?: string;
  ready: () => Readiness;
}

export interface HealthServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Serves `GET /healthz` (process alive) and `GET /readyz` (polling Temporal) for load balancers,
 * ECS and Kubernetes probes.
 */
export function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (path !== '/healthz' && path !== '/readyz') return send(404, { status: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { status: 'method not allowed' });
    if (path === '/healthz') return send(200, { status: 'ok' });
    let readiness: Readiness;
    try {
      readiness = options.ready();
    } catch {
      readiness = false;
    }
    const { ready, details } = typeof readiness === 'boolean' ? { ready: readiness, details: undefined } : readiness;
    send(ready ? 200 : 503, { status: ready ? 'ready' : 'not ready', ...(details ? { details } : {}) });
  });
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(new Error(`Health server could not listen on port ${options.port}: ${error.code ?? error.message}`, { cause: error }));
    });
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
