import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, packageManagerFrom, type CreateIo } from '../src/index.ts';

const ownVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;

let cwd: string;
let out: string;
let runs: { command: string; args: string[]; cwd: string }[];

function io(overrides: Partial<CreateIo> = {}): CreateIo {
  return {
    cwd,
    env: { npm_config_user_agent: 'pnpm/10.28.0 npm/? node/v24.0.0 darwin arm64' },
    stdout: (s) => (out += s),
    stderr: (s) => (out += s),
    run: async (command, args, options) => {
      runs.push({ command, args, cwd: options.cwd });
      return 0;
    },
    ...overrides,
  };
}

const read = (...path: string[]) => readFileSync(join(cwd, ...path), 'utf8');

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'norn-create-'));
  out = '';
  runs = [];
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('scaffolding', () => {
  it('writes the starter project with its name and this version of Norn', async () => {
    expect(await main(['my-app'], io())).toBe(0);

    const pkg = JSON.parse(read('my-app', 'package.json'));
    expect(pkg.name).toBe('my-app');
    expect(pkg.dependencies['@norn-ts/norn']).toBe(`^${ownVersion}`);
    for (const deps of [pkg.dependencies, pkg.devDependencies]) {
      for (const range of Object.values(deps)) expect(range).not.toMatch(/\{\{|workspace:/);
    }
    for (const file of ['src/workflows/order.workflow.ts', 'src/worker.ts', 'test/order.workflow.test.ts', 'src/workflows/index.ts', 'AGENTS.md']) {
      expect(existsSync(join(cwd, 'my-app', file)), file).toBe(true);
    }
    expect(read('my-app', 'README.md')).toContain('# my-app');
  });

  it('restores dotfiles that npm would strip from the published template', async () => {
    await main(['my-app'], io());
    expect(read('my-app', '.gitignore')).toContain('node_modules');
    expect(existsSync(join(cwd, 'my-app', '_gitignore'))).toBe(false);
  });

  it('ships the same agent skill as the repository', async () => {
    await main(['my-app'], io());
    const repoSkill = readFileSync(new URL('../../../skills/norn/SKILL.md', import.meta.url), 'utf8');
    expect(read('my-app', '.claude/skills/norn/SKILL.md')).toBe(repoSkill);
  });

  it('installs with the package manager that ran it, then prints the next steps', async () => {
    await main(['my-app'], io());
    const dir = join(cwd, 'my-app');
    expect(runs).toEqual([
      { command: 'pnpm', args: ['install'], cwd: dir },
    ]);
    expect(out).toContain('cd my-app');
    expect(out).toContain('pnpm dev');
  });

  it('uses npm when no package manager is identified', async () => {
    await main(['my-app'], io({ env: {} }));
    expect(runs[0]).toMatchObject({ command: 'npm', args: ['install'] });
    expect(out).toContain('npm run dev');
  });

  it('skips the install with --no-install', async () => {
    await main(['my-app', '--no-install'], io());
    expect(runs).toEqual([]);
    expect(out).toContain('pnpm install');
  });

  it('scaffolds into an existing empty directory, including "."', async () => {
    const dir = join(cwd, 'empty');
    mkdirSync(dir);
    expect(await main(['.'], io({ cwd: dir }))).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name).toBe('empty');
    expect(out).not.toContain('cd .');
  });

  it('accepts a path and names the project after its last segment', async () => {
    expect(await main(['apps/billing'], io())).toBe(0);
    expect(JSON.parse(read('apps', 'billing', 'package.json')).name).toBe('billing');
    expect(out).toContain('cd apps/billing');
  });

  it('asks for the name when none is given', async () => {
    const asked: string[] = [];
    const prompt = async (question: string) => (asked.push(question), 'from-prompt');
    expect(await main([], io({ prompt }))).toBe(0);
    expect(asked).toHaveLength(1);
    expect(existsSync(join(cwd, 'from-prompt', 'package.json'))).toBe(true);
  });
});

describe('refusals', () => {
  it('refuses a directory that is not empty', async () => {
    mkdirSync(join(cwd, 'taken'));
    writeFileSync(join(cwd, 'taken', 'keep.txt'), 'mine');
    expect(await main(['taken'], io())).toBe(1);
    expect(out).toContain('not empty');
    expect(out).toContain('--force');
    expect(existsSync(join(cwd, 'taken', 'package.json'))).toBe(false);
    expect(runs).toEqual([]);
  });

  it('writes into a non-empty directory with --force, keeping unrelated files', async () => {
    mkdirSync(join(cwd, 'taken'));
    writeFileSync(join(cwd, 'taken', 'keep.txt'), 'mine');
    expect(await main(['taken', '--force'], io())).toBe(0);
    expect(read('taken', 'keep.txt')).toBe('mine');
    expect(existsSync(join(cwd, 'taken', 'package.json'))).toBe(true);
  });

  it.each(['My App', '.hidden', '_under', 'apps/Bad Name', ''])('rejects %j as a package name', async (name) => {
    expect(await main([name], io())).not.toBe(0);
    expect(out).toMatch(/name/i);
    expect(runs).toEqual([]);
  });

  it('fails when no name is given and there is no terminal to ask', async () => {
    expect(await main([], io({ prompt: undefined }))).toBe(2);
    expect(out).toContain('Usage');
  });

  it('rejects unknown options', async () => {
    expect(await main(['my-app', '--bogus'], io())).toBe(2);
    expect(existsSync(join(cwd, 'my-app'))).toBe(false);
  });

  it('reports a failed install and does not print the next steps', async () => {
    const code = await main(['my-app'], io({ run: async () => 1 }));
    expect(code).toBe(1);
    expect(out).toContain('pnpm install failed');
    expect(out).not.toContain('pnpm dev');
  });
});

describe('help', () => {
  it('prints usage with --help', async () => {
    expect(await main(['--help'], io())).toBe(0);
    expect(out).toContain('Usage: pnpm create @norn-ts');
  });
});

describe('packageManagerFrom', () => {
  it.each([
    ['pnpm/10.28.0 npm/? node/v24.0.0', 'pnpm'],
    ['yarn/4.5.0 npm/? node/v24.0.0', 'yarn'],
    ['bun/1.2.0 npm/? node/v24.0.0', 'bun'],
    ['npm/10.9.0 node/v24.0.0', 'npm'],
    [undefined, 'npm'],
  ])('%s → %s', (agent, expected) => {
    expect(packageManagerFrom(agent)).toBe(expected);
  });
});
