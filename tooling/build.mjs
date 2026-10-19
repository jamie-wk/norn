#!/usr/bin/env node
// Builds every package under packages/ in dependency order.
// `pnpm -r build` can't be used: several packages dev-depend on @norn/testing, which depends on
// them at runtime, so pnpm's topological sort sees a cycle and picks an arbitrary order. Only
// dependencies and peerDependencies matter for a build (tsc reads their dist/*.d.ts), so order by
// those and build each level in parallel.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const packagesDir = new URL('../packages/', import.meta.url).pathname;

const packages = new Map();
for (const dir of readdirSync(packagesDir)) {
  const manifest = JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'));
  if (!manifest.scripts?.build) continue;
  packages.set(manifest.name, { dir: join(packagesDir, dir), manifest });
}

const internalDeps = (manifest) =>
  [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})].filter((name) =>
    packages.has(name),
  );

const levels = [];
const done = new Set();
while (done.size < packages.size) {
  const level = [...packages.keys()].filter(
    (name) => !done.has(name) && internalDeps(packages.get(name).manifest).every((dep) => done.has(dep)),
  );
  if (level.length === 0) {
    const left = [...packages.keys()].filter((name) => !done.has(name));
    console.error(`Dependency cycle among: ${left.join(', ')}`);
    process.exit(1);
  }
  levels.push(level);
  for (const name of level) done.add(name);
}

const run = (name) =>
  new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['run', 'build'], { cwd: packages.get(name).dir, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} build failed (exit ${code})`))));
    child.on('error', reject);
  });

try {
  for (const level of levels) {
    console.log(`> building ${level.join(', ')}`);
    await Promise.all(level.map(run));
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
