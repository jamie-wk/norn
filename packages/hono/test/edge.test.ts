import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';

const entry = (name: string) => fileURLToPath(new URL(`../src/${name}`, import.meta.url));

async function bundle(file: string) {
  const result = await build({
    entryPoints: [entry(file)],
    bundle: true,
    write: false,
    format: 'esm',
    // A browser target fails on any Node built-in, like edge runtimes without Node compatibility.
    platform: 'browser',
    conditions: ['@norn/source'],
    metafile: true,
    logLevel: 'silent',
  });
  return Object.keys(result.metafile.inputs);
}

describe('runtime neutrality', () => {
  it('bundles @norn-ts/hono/codec-server for edge runtimes without Node built-ins or the Temporal client', async () => {
    const inputs = await bundle('codec-server.ts');
    expect(inputs.some((i) => i.includes('codec-server.ts'))).toBe(true);
    expect(inputs.filter((i) => i.includes('@temporalio') || i.includes('packages/client/'))).toEqual([]);
  });

  it('keeps Node APIs out of this package itself (they only come from @norn-ts/client)', async () => {
    for (const file of ['errors.ts', 'webhook.ts', 'hmac.ts', 'middleware.ts', 'internal.ts']) {
      const withComments = await import('node:fs').then((fs) => fs.readFileSync(entry(file), 'utf8'));
      const source = withComments.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(source).not.toMatch(/from 'node:/);
      expect(source).not.toMatch(/\bprocess\.|\bBuffer\b/);
    }
  });
});
