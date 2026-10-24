import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { main } from '../src/index.ts';

// The project is scaffolded under packages/create/.tmp, so its imports resolve to this package's
// devDependencies (the built workspace packages and the template's tools) without an install.
const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const bin = join(pkgDir, 'node_modules/.bin');
let dir: string;

function run(script: string) {
  // Run the binaries directly: the scripts' inner commands (`norn`, `tsc`, `vitest`) come from PATH.
  const [command, ...args] = script.split(' ') as [string, ...string[]];
  const result = spawnSync(join(bin, command), args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
  // CI forces colored output; match on plain text.
  return { status: result.status, output: stripVTControlCharacters(`${result.stdout}${result.stderr}`) };
}

beforeAll(async () => {
  mkdirSync(join(pkgDir, '.tmp'), { recursive: true });
  const parent = mkdtempSync(join(pkgDir, '.tmp', 'scaffold-'));
  let out = '';
  const code = await main(['starter', '--no-install'], { cwd: parent, env: {}, stdout: (s) => (out += s), stderr: (s) => (out += s) });
  if (code !== 0) throw new Error(out);
  dir = join(parent, 'starter');
});

afterAll(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

it('typechecks', () => {
  const result = run('tsc --noEmit');
  expect(result.output).toBe('');
  expect(result.status).toBe(0);
});

it("passes its own tests on Temporal's time-skipping server", () => {
  const result = run('vitest run');
  expect(result.output).toMatch(/Tests\s+3 passed \(3\)/);
  expect(result.status).toBe(0);
});
