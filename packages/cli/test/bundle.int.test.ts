import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { copyFixture, removeDir } from './helpers.ts';

let dir: string;
let output = '';
const run = (args: string[]) => {
  output = '';
  return main(args, { cwd: dir, stdout: (s) => (output += s), stderr: (s) => (output += s) });
};

beforeAll(async () => {
  dir = copyFixture('app');
  rmSync(join(dir, 'expected'), { recursive: true, force: true });
  if ((await run(['gen'])) !== 0) throw new Error(output);
});
afterAll(() => removeDir(dir));

describe('norn bundle', () => {
  it('bundles the generated workflows barrel with the correlation interceptors', async () => {
    expect(await run(['bundle'])).toBe(0);
    const file = join(dir, 'dist/workflow-bundle.js');
    expect(output).toContain('wrote dist/workflow-bundle.js');
    const code = readFileSync(file, 'utf8');
    for (const name of ['OrderWorkflow', 'ShoppingCart', 'ReportWorkflow']) expect(code).toContain(`${name}: () => (/* binding */ ${name})`);
    expect(code).toContain('workflow-interceptors');
    // Activity implementations stay out of the workflow bundle.
    expect(code).not.toContain('class PaymentActivities');
    expect(code).not.toContain('NornJsonPayloadConverter');
  });

  it('includes the codec payload converter with --codec, at a custom path', async () => {
    expect(await run(['bundle', '--codec', '--out', 'build/wf.js'])).toBe(0);
    const code = readFileSync(join(dir, 'build/wf.js'), 'utf8');
    expect(code).toContain('NornJsonPayloadConverter');
  });

  it('fails clearly when gen has not run', async () => {
    rmSync(join(dir, '.norn'), { recursive: true });
    expect(await run(['bundle', '--out', 'x.js'])).toBe(1);
    expect(output).toContain('Run norn gen first');
    expect(existsSync(join(dir, 'x.js'))).toBe(false);
  });
});
