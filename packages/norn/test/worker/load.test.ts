import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NornConfigError } from '../../src/core/index.ts';
import { activityFunctions, loadWorkflows } from '../../src/worker/load.ts';

const fixture = fileURLToPath(new URL('./fixtures/workflows.ts', import.meta.url));

class Base {
  constructor(protected readonly prefix: string) {}
  async greet(name: string) {
    return `${this.prefix} ${name}`;
  }
}
class Greeter extends Base {
  override async greet(name: string) {
    return `${await super.greet(name)}!`;
  }
  async wave() {
    return this.prefix;
  }
}

describe('activityFunctions', () => {
  it('registers every method as <namespace>.<method>, bound to its instance, subclass first', async () => {
    const fns = activityFunctions({ greet: new Greeter('hi'), plain: { ping: async () => 'pong' } });
    expect(Object.keys(fns).sort()).toEqual(['greet.greet', 'greet.wave', 'plain.ping']);
    expect(await fns['greet.greet']!('ann')).toBe('hi ann!');
    expect(await fns['greet.wave']!()).toBe('hi');
  });

  it('rejects a namespace that is not an object', () => {
    expect(() => activityFunctions({ bad: 'x' as never })).toThrow(NornConfigError);
  });
});

describe('loadWorkflows', () => {
  let dir: string | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads task queues without writing anything, so a prebuilt bundle works on a read-only filesystem', async () => {
    dir = await mkdtemp(join(tmpdir(), 'norn-load-'));
    vi.stubEnv('TMPDIR', dir);
    const loaded = await loadWorkflows(fixture);
    expect(loaded.taskQueues).toEqual(['w-main', 'w-reports']);
    expect(await readdir(dir)).toEqual([]);
  });

  it('falls back to the compiled .js when the .ts path is gone after a build', async () => {
    dir = await mkdtemp(join(tmpdir(), 'norn-build-'));
    await writeFile(join(dir, 'index.js'), `export * from ${JSON.stringify(fixture)};\n`);
    const loaded = await loadWorkflows(join(dir, 'index.ts'));
    expect(loaded.path).toBe(join(dir, 'index.js'));
    expect(loaded.taskQueues).toEqual(['w-main', 'w-reports']);
  });

  it('keeps a missing path when there is no compiled file either', async () => {
    dir = await mkdtemp(join(tmpdir(), 'norn-build-'));
    await expect(loadWorkflows(join(dir, 'index.ts'))).rejects.toThrow();
  });
});
