import { describe, expect, it, vi } from 'vitest';
import { NornConfigError } from '@norn-ts/core';
import { workerSet, type RunnableWorker } from '../src/worker-set.ts';

/** A worker whose run() lasts until shutdown(), or until the test fails it. */
function fakeWorker(): RunnableWorker & { fail(error: Error): void; shutdowns: number } {
  let state = 'INITIALIZED';
  let settle: { resolve: () => void; reject: (e: Error) => void } | undefined;
  const worker = {
    shutdowns: 0,
    getState: () => state,
    run: () =>
      new Promise<void>((resolve, reject) => {
        state = 'RUNNING';
        settle = { resolve, reject };
      }).finally(() => {
        state = state === 'FAILED' ? 'FAILED' : 'STOPPED';
      }),
    shutdown() {
      worker.shutdowns++;
      state = 'STOPPING';
      settle?.resolve();
    },
    fail(error: Error) {
      state = 'FAILED';
      settle?.reject(error);
    },
  };
  return worker;
}

const quietLog = { info: () => {} };

describe('workerSet', () => {
  it('runs every worker, then stops them all on shutdown and cleans up once', async () => {
    const workers = [fakeWorker(), fakeWorker()];
    const cleanup = vi.fn(async () => {});
    const set = workerSet(workers, cleanup, quietLog);
    expect(set.state).toBe('INITIALIZED');

    const running = set.run();
    expect(set.state).toBe('RUNNING');
    expect(set.run()).toBe(running);

    await set.shutdown();
    await running;
    expect(set.state).toBe('STOPPED');
    expect(workers.map((w) => w.shutdowns)).toEqual([1, 1]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('stops the other workers when one fails, and rejects with its error', async () => {
    const [a, b] = [fakeWorker(), fakeWorker()];
    const cleanup = vi.fn(async () => {});
    const set = workerSet([a, b], cleanup, quietLog);
    const running = set.run();

    a.fail(new Error('poller crashed'));
    await expect(running).rejects.toThrow('poller crashed');
    expect(b.shutdowns).toBe(1);
    expect(set.state).toBe('FAILED');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans up without running when shut down first, and then refuses to run', async () => {
    const cleanup = vi.fn(async () => {});
    const set = workerSet([fakeWorker()], cleanup, quietLog);
    await set.shutdown();
    expect(set.state).toBe('STOPPED');
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(set.run()).rejects.toThrow(NornConfigError);
    await set.shutdown();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
