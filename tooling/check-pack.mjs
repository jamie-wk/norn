#!/usr/bin/env node
// Packs every published package the way npm will see it and checks the tarball:
// built entry points and types exist, README/LICENSE are included, no tests or fixtures leak,
// workspace: ranges are rewritten, and publint finds nothing.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), 'norn-pack-'));
const errors = [];
let checked = 0;

function exportTargets(exports) {
  const targets = [];
  const walk = (value) => {
    if (typeof value === 'string') targets.push(value);
    else if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) if (key !== '@norn/source') walk(v);
  };
  walk(exports);
  return targets.filter((t) => !t.endsWith('package.json'));
}

try {
  for (const dir of readdirSync(join(root, 'packages'))) {
    const pkgDir = join(root, 'packages', dir);
    if (!existsSync(join(pkgDir, 'package.json'))) continue;
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    if (pkg.private) continue;
    checked++;
    const tarball = execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: pkgDir, encoding: 'utf8' }).trim().split('\n').at(-1);
    const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => f.replace(/^package\//, ''));
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
    const has = (file) => listing.includes(file.replace(/^\.\//, ''));

    for (const required of ['package.json', 'README.md', 'LICENSE']) if (!has(required)) errors.push(`${pkg.name}: tarball is missing ${required}`);
    for (const target of exportTargets(pkg.exports)) if (!has(target)) errors.push(`${pkg.name}: export target ${target} is not in the tarball (did you build?)`);
    for (const bin of Object.values(pkg.bin ?? {})) if (!has(bin)) errors.push(`${pkg.name}: bin ${bin} is not in the tarball`);
    // A scaffolder's template/ ships its tests on purpose.
    const leaked = listing.filter((f) => !f.startsWith('template/')).filter((f) => /(^|\/)(test|fixtures|__snapshots__)\//.test(f) || /\.test\.[cm]?[jt]s$/.test(f));
    if (leaked.length) errors.push(`${pkg.name}: tarball includes test files: ${leaked.slice(0, 5).join(', ')}`);
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (String(range).startsWith('workspace:')) errors.push(`${pkg.name}: ${field}.${dep} is still "${range}" in the packed manifest`);
      }
    }
    try {
      execFileSync(join(root, 'node_modules/.bin/publint'), ['run', pkgDir, '--strict'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      errors.push(`${pkg.name}: publint failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`);
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`check-pack found ${errors.length} problem(s):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-pack: ${checked} packages OK`);
