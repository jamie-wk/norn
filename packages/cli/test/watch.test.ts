import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { watch, type GenerateResult } from '../src/index.ts';
import { copyFixture, removeDir } from './helpers.ts';

let dir: string;
afterAll(() => removeDir(dir));

describe('watch', () => {
  it('regenerates on change and stops when the signal aborts', async () => {
    dir = copyFixture('app');
    const results: GenerateResult[] = [];
    const controller = new AbortController();
    let notify: () => void = () => {};
    const done = watch({
      cwd: dir,
      signal: controller.signal,
      debounceMs: 50,
      onResult: (result) => {
        results.push(result);
        notify();
      },
    });
    const next = (count: number) =>
      new Promise<void>((resolve) => {
        notify = () => results.length >= count && resolve();
        notify();
      });

    await next(1);
    expect(results[0]!.errors).toEqual([]);
    expect(results[0]!.written).toContain('.norn/contracts.ts');

    const cart = join(dir, 'src/workflows/cart.ts');
    writeFileSync(cart, readFileSync(cart, 'utf8').replace('@Signal() checkout()', "@Signal() abandon() {}\n\n  @Signal() checkout()"));
    await next(2);
    expect(results[1]!.errors).toEqual([]);
    expect(readFileSync(join(dir, '.norn/contracts.ts'), 'utf8')).toContain("abandon: 'abandon'");

    controller.abort();
    await expect(done).resolves.toBeUndefined();
    // Writes after stopping are not picked up.
    writeFileSync(cart, readFileSync(cart, 'utf8').replace('abandon()', 'leave()'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(results).toHaveLength(2);
  });

  it('resolves immediately for an already-aborted signal', async () => {
    await expect(watch({ cwd: dir, signal: AbortSignal.abort() })).resolves.toBeUndefined();
  });
});
