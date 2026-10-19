import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFixture, removeDir } from './helpers.ts';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const tsc = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url));
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string; bin: { norn: string } };
// The committed stub that imports dist/bin.js, so every test below also covers it.
const bin = join(pkgDir, pkg.bin.norn);

// Plain Node: no vitest transforms and no @norn/source condition, exactly like an installed CLI.
const norn = (args: string[], cwd: string) => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env });
};

let dir: string;
beforeAll(() => {
  const build = spawnSync(tsc, ['-p', join(pkgDir, 'tsconfig.build.json')], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}${build.stderr}`);
  dir = copyFixture('app');
  rmSync(join(dir, 'expected'), { recursive: true, force: true });
});
afterAll(() => dir && removeDir(dir));

describe('the built norn binary', () => {
  it('is the package bin and starts with a shebang', () => {
    expect(pkg.bin.norn).toBe('./bin/norn.js');
    expect(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(readFileSync(join(pkgDir, 'dist/bin.js'), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('prints its version and help', () => {
    expect(norn(['--version'], dir)).toMatchObject({ status: 0, stdout: `${pkg.version}\n` });
    expect(norn(['--help'], dir).stdout).toContain('schedules sync');
    expect(norn(['nope'], dir).status).toBe(2);
  });

  it('generates, checks and reports staleness, loading norn.config.ts with plain Node', () => {
    const gen = norn(['gen'], dir);
    expect(gen.stderr.replace(/^.*ExperimentalWarning.*\n?/gm, '').replace(/^\(Use `node --trace-warnings.*\n?/gm, '')).toBe('');
    expect(gen.status).toBe(0);
    expect(gen.stdout).toContain('wrote .norn/registry.ts');
    expect(norn(['gen', '--check'], dir).status).toBe(0);
    const order = join(dir, 'src/workflows/order.ts');
    writeFileSync(order, readFileSync(order, 'utf8').replace("@Signal() complete()", "@Signal() complete() {}\n\n  @Signal() rush()"));
    const check = norn(['gen', '--check'], dir);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('.norn/contracts.ts');
  });

  it('prints errors with locations and exits 1', () => {
    const order = join(dir, 'src/workflows/order.ts');
    writeFileSync(order, `${readFileSync(order, 'utf8')}\nexport const leak = () => process.env.HOME;\n`);
    const result = norn(['gen'], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/src\/workflows\/order\.ts:\d+:\d+ - error norn\(determinism\)/);
  });
});
