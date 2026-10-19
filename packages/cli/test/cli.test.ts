import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { copyFixture, fixture, project, removeDir } from './helpers.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

async function run(argv: string[], cwd = process.cwd(), env: Record<string, string | undefined> = {}) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, { cwd, env, stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout, stderr };
}

const dirs: string[] = [];
afterAll(() => dirs.forEach(removeDir));

describe('norn CLI', () => {
  it('prints help and version', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    for (const cmd of ['gen', 'schedules sync', 'histories pull', 'bundle']) expect(help.stdout).toContain(cmd);
    expect((await run(['-h'])).code).toBe(0);
    const version = await run(['--version']);
    expect(version).toMatchObject({ code: 0, stdout: `${pkg.version}\n` });
    const genHelp = await run(['gen', '--help']);
    expect(genHelp.code).toBe(0);
    expect(genHelp.stdout).toContain('--accept-rename');
  });

  it('exits 2 on usage errors', async () => {
    expect((await run([])).code).toBe(2);
    const unknown = await run(['deploy']);
    expect(unknown).toMatchObject({ code: 2 });
    expect(unknown.stderr).toContain('Unknown command "deploy"');
    const flag = await run(['gen', '--frobnicate']);
    expect(flag.code).toBe(2);
    expect(flag.stderr).toContain('--frobnicate');
    expect((await run(['gen', 'extra'])).code).toBe(2);
    expect((await run(['schedules'])).code).toBe(2);
    expect((await run(['schedules', 'nuke'])).code).toBe(2);
    expect((await run(['histories', 'pull'])).stderr).toContain('workflow ID');
    expect((await run(['histories', 'pull'])).code).toBe(2);
    expect((await run(['histories'])).code).toBe(2);
    expect((await run(['gen', '--check', '--watch'])).code).toBe(2);
  });

  it('gen: prints every error and exits 1', async () => {
    const result = await run(['gen'], fixture('errors/determinism'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('src/order.ts:10:5 - error norn(determinism)');
    expect(result.stderr).toContain('9 errors');
  });

  it('gen: writes, then reports up to date, then --check finds stale files', async () => {
    const dir = copyFixture('app');
    dirs.push(dir);
    const first = await run(['gen'], dir);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('wrote .norn/workflows.ts');
    expect(first.stdout).toContain('wrote norn.lock.json');
    const second = await run(['gen'], dir);
    expect(second).toMatchObject({ code: 0 });
    expect(second.stdout).toContain('up to date');
    expect((await run(['gen', '--check'], dir)).code).toBe(0);

    const cart = join(dir, 'src/workflows/cart.ts');
    writeFileSync(cart, readFileSync(cart, 'utf8').replace("taskQueue: 'carts'", "taskQueue: 'carts', description: 'Carts'"));
    writeFileSync(cart, readFileSync(cart, 'utf8').replace('@Signal() checkout()', '@Signal() abandon() {}\n\n  @Signal() checkout()'));
    const stale = await run(['gen', '--check'], dir);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain('.norn/contracts.ts');
    expect(stale.stderr).toContain('norn gen');
  });

  it('gen: --accept-rename and --config are passed through', async () => {
    const dir = copyFixture('errors/lock-rename');
    dirs.push(dir);
    const refused = await run(['gen'], dir);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('--accept-rename');
    expect((await run(['gen', '--accept-rename'], dir)).code).toBe(0);

    const other = project({ 'cfg/norn.config.ts': "export default { include: ['../src/**/*.ts'] };\n", 'src/x.ts': 'export const x = 1;\n' });
    dirs.push(other);
    expect((await run(['gen', '--config', 'cfg/norn.config.ts'], other)).code).toBe(0);
    expect(existsSync(join(other, 'cfg/.norn/workflows.ts'))).toBe(true);
  });

  it('gen --watch: generates, then stops on the signal', async () => {
    const dir = copyFixture('app');
    dirs.push(dir);
    const controller = new AbortController();
    let stdout = '';
    const done = main(['gen', '--watch'], {
      cwd: dir,
      signal: controller.signal,
      stdout: (s) => {
        stdout += s;
        if (s.includes('wrote norn.lock.json')) controller.abort();
      },
      stderr: () => {},
    });
    await expect(done).resolves.toBe(0);
    expect(stdout).toContain('wrote .norn/registry.ts');
  });

  it('bundle: asks for norn gen first when the barrel is missing', async () => {
    const dir = project({ 'src/x.ts': 'export const x = 1;\n' });
    dirs.push(dir);
    const result = await run(['bundle'], dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('norn gen');
  });

  it('schedules sync: reports a missing schedules.json', async () => {
    const dir = project({ 'src/x.ts': 'export const x = 1;\n' });
    dirs.push(dir);
    const result = await run(['schedules', 'sync', '--dry-run'], dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('schedules.json');
  });
});
