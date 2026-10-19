import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defineConfig, generate, loadConfig } from '../src/index.ts';
import { expectError, project, removeDir } from './helpers.ts';

const dirs: string[] = [];
afterAll(() => dirs.forEach(removeDir));
function temp(files: Record<string, string>): string {
  const dir = project(files);
  dirs.push(dir);
  return dir;
}

const workflow = (name: string, queue = 'q') => `import { Workflow } from '@norn/workflow';

@Workflow({ taskQueue: '${queue}' })
export class ${name} {
  async run() {}
}
`;

describe('configuration', () => {
  it('defineConfig is an identity function', () => {
    const config = { outDir: 'gen' };
    expect(defineConfig(config)).toBe(config);
  });

  it('uses defaults when there is no config file and skips test files', async () => {
    const dir = temp({
      'src/a.ts': workflow('AWorkflow'),
      'src/a.test.ts': '@Nonsense(x) export class Broken {}',
      'src/types.d.ts': 'declare const x: number;',
      'other/b.ts': workflow('BWorkflow'),
    });
    const config = await loadConfig({ cwd: dir });
    expect(config).toMatchObject({ root: dir, configFile: undefined, outDir: join(dir, '.norn'), importExtension: '.js' });
    const { errors, files } = await generate({ cwd: dir, write: false });
    expect(errors).toEqual([]);
    expect(files['.norn/workflows.ts']).toContain('AWorkflow');
    expect(files['.norn/workflows.ts']).not.toContain('BWorkflow');
  });

  it('honours include, exclude, outDir and importExtension', async () => {
    const dir = temp({
      'norn.config.ts': `export default { include: ['app/**/*.ts', 'lib/**/*.ts'], exclude: ['**/legacy/**'], outDir: 'app/generated', importExtension: '.ts' };\n`,
      'app/a.ts': workflow('AWorkflow'),
      'app/legacy/old.ts': workflow('OldWorkflow'),
      'lib/b.ts': workflow('BWorkflow', 'other'),
      'app/generated/stale.ts': '@Nonsense(x) export class Broken {}',
    });
    const { errors, files } = await generate({ cwd: dir, write: false });
    expect(errors).toEqual([]);
    const workflows = files['app/generated/workflows.ts']!;
    expect(workflows).toContain("from '../a.ts'");
    expect(workflows).toContain("from '../../lib/b.ts'");
    expect(workflows).not.toContain('OldWorkflow');
    expect(files['app/generated/registry.ts']).toContain("from './container.ts'");
    expect(files['app/generated/registry.ts']).toContain("taskQueues: ['other', 'q']");
  });

  it('loads an explicit --config path and resolves paths against its directory', async () => {
    const dir = temp({
      'config/custom.config.ts': `import { defineConfig } from '@norn/cli';\nexport default defineConfig({ include: ['../src/**/*.ts'], outDir: '../out' });\n`,
      'src/a.ts': workflow('AWorkflow'),
    });
    const result = await generate({ cwd: dir, configPath: 'config/custom.config.ts', write: false });
    expect(result.errors).toEqual([]);
    // Paths are relative to the project root: the directory of the config file.
    expect(Object.keys(result.files)).toContain('../out/workflows.ts');
    expect(Object.keys(result.files)).toContain('norn.lock.json');
    expect(result.files['../out/workflows.ts']).toContain("from '../src/a.js'");
  });

  it('reports invalid configuration', async () => {
    const dir = temp({ 'norn.config.ts': `export default { outDir: 42, include: 'src', importExtension: '.mjs', bogus: true };\n` });
    const { errors } = await generate({ cwd: dir, write: false });
    expectError(errors, { code: 'config', file: 'norn.config.ts', message: 'outDir must be a string' });
    expectError(errors, { code: 'config', message: 'include must be an array of globs' });
    expectError(errors, { code: 'config', message: "importExtension must be '.js' or '.ts'" });
    expectError(errors, { code: 'config', message: 'unknown option "bogus"' });
    expect(errors).toHaveLength(4);
  });

  it('reports a config file without a default export, or one that throws', async () => {
    const noDefault = (await generate({ cwd: temp({ 'norn.config.ts': 'export const config = {};\n' }), write: false })).errors;
    expectError(noDefault, { code: 'config', file: 'norn.config.ts', message: 'default export' });
    const throws = (await generate({ cwd: temp({ 'norn.config.ts': "throw new Error('boom');\n" }), write: false })).errors;
    expectError(throws, { code: 'config', message: 'boom' });
    const missing = (await generate({ cwd: temp({}), configPath: 'nope.config.ts', write: false })).errors;
    expectError(missing, { code: 'config', message: 'nope.config.ts' });
    expect([noDefault.length, throws.length, missing.length]).toEqual([1, 1, 1]);
  });

  it('checks the providers module', async () => {
    const missing = temp({ 'norn.config.ts': `export default { providers: 'src/providers.ts' };\n`, 'src/a.ts': workflow('AWorkflow') });
    const missingErrors = (await generate({ cwd: missing, write: false })).errors;
    expectError(missingErrors, { code: 'config', message: 'src/providers.ts does not exist' });
    const noExport = temp({
      'norn.config.ts': `export default { providers: 'src/providers.ts' };\n`,
      'src/providers.ts': 'export const others = [];\n',
    });
    const noExportErrors = (await generate({ cwd: noExport, write: false })).errors;
    expectError(noExportErrors, { code: 'config', file: 'src/providers.ts', message: 'export named "providers"' });
    expect([missingErrors.length, noExportErrors.length]).toEqual([1, 1]);
  });

  it('writes an empty but valid workflows barrel when there are no workflows', async () => {
    const dir = temp({ 'src/util.ts': 'export const x = 1;\n' });
    const { errors, files } = await generate({ cwd: dir });
    expect(errors).toEqual([]);
    expect(files['.norn/workflows.ts']).toBe('// Generated by norn gen. Do not edit.\n\nexport {};\n');
    expect(files['.norn/container.ts']).toContain('createContainer({ ...options })');
    expect(existsSync(join(dir, '.norn/registry.ts'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'norn.lock.json'), 'utf8'))).toEqual({ version: 1, workflows: {}, activities: [] });
  });

  it('aliases dependency keys that share a name across modules', async () => {
    const dir = temp({
      'src/a/config.ts': "import { token } from '@norn/activity';\nexport interface Config { a: 1 }\nexport const Config = token<Config>('AConfig');\n",
      'src/b/config.ts': "import { token } from '@norn/activity';\nexport interface Config { b: 1 }\nexport const Config = token<Config>('BConfig');\n",
      'src/acts.ts': `import { Activities, Activity } from '@norn/activity';
import type { Config } from './a/config.js';
import type { Config as OtherConfig } from './b/config.js';
import { Pool } from 'pg';

@Activities()
export class Acts {
  constructor(readonly a: Config, readonly b: OtherConfig, readonly pool: Pool) {}
  @Activity() async go() {}
}
`,
    });
    const { errors, files } = await generate({ cwd: dir, write: false });
    expect(errors).toEqual([]);
    const container = files['.norn/container.ts']!;
    expect(container).toContain("import { Config } from '../src/a/config.js';");
    expect(container).toContain("import { Config as Config$1 } from '../src/b/config.js';");
    expect(container).toContain("import { Pool } from 'pg';");
    expect(container).toContain('{ cls: Acts, deps: [Config, Config$1, Pool] }');
  });
});
