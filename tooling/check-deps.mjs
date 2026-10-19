#!/usr/bin/env node
// Dependency discipline for published packages:
// - every bare import in src/ is declared (dependencies or peerDependencies; node: builtins aside)
// - @norn-ts/core has no runtime dependencies; @norn-ts/workflow only depends on core + Temporal's workflow SDK
// - workflow-sandbox entry points import nothing Node-specific
// - all @norn-ts/* packages share one version, and metadata needed for publishing is present
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const packagesDir = join(root, 'packages');
const errors = [];
const fail = (pkg, message) => errors.push(`${pkg}: ${message}`);

const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;(])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[\s;])import\s+['"]([^'"]+)['"]/gm;

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (/\.[cm]?tsx?$/.test(entry) && !/\.(test|test-d)\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

function packageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** Packages whose code (or part of it) runs inside the Temporal workflow sandbox. */
const SANDBOX = {
  '@norn-ts/core': ['src'],
  '@norn-ts/workflow': ['src'],
  '@norn-ts/worker': ['src/workflow-interceptors.ts'],
  '@norn-ts/codec': ['src/payload-converter.ts'],
};

const versions = new Map();
for (const dir of readdirSync(packagesDir)) {
  const pkgPath = join(packagesDir, dir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    continue;
  }
  if (pkg.private) continue;
  const name = pkg.name;
  versions.set(name, pkg.version);
  const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);

  for (const field of ['license', 'repository', 'homepage', 'engines', 'exports', 'files', 'publishConfig']) {
    if (!pkg[field]) fail(name, `package.json is missing "${field}"`);
  }
  if (pkg.license !== 'MIT') fail(name, 'license must be MIT');
  if (pkg.repository?.directory !== `packages/${dir}`) fail(name, `repository.directory should be packages/${dir}`);
  if (pkg.publishConfig?.access !== 'public') fail(name, 'publishConfig.access must be public');
  for (const [dep, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (String(range).startsWith('workspace:')) fail(name, `peer dependency ${dep} must not use the workspace: protocol`);
  }

  const srcDir = join(packagesDir, dir, 'src');
  for (const file of files(srcDir)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      // Skip strings inside templates and messages, e.g. `import x from '${source}'`.
      if (!specifier || /[\s${}]/.test(specifier)) continue;
      const rel = relative(join(packagesDir, dir), file);
      if (builtins.has(specifier) || builtins.has(specifier.split('/')[0])) {
        const sandboxed = SANDBOX[name]?.some((p) => rel === p || rel.startsWith(`${p}/`));
        if (sandboxed) fail(name, `${rel} runs in the workflow sandbox but imports ${specifier}`);
        continue;
      }
      const dep = packageName(specifier);
      if (!dep || dep === name) continue;
      if (!declared.has(dep)) fail(name, `${rel} imports ${dep}, which is not in dependencies or peerDependencies`);
    }
  }

  if (name === '@norn-ts/core' && Object.keys(pkg.dependencies ?? {}).length > 0) fail(name, 'must have no runtime dependencies');
  if (name === '@norn-ts/workflow') {
    const allowed = new Set(['@norn-ts/core']);
    for (const dep of Object.keys(pkg.dependencies ?? {})) if (!allowed.has(dep)) fail(name, `may only depend on @norn-ts/core, found ${dep}`);
    for (const dep of Object.keys(pkg.peerDependencies ?? {})) {
      if (!['@temporalio/workflow', '@temporalio/common'].includes(dep)) fail(name, `unexpected peer dependency ${dep}`);
    }
  }
}

const distinct = new Set(versions.values());
if (distinct.size > 1) errors.push(`@norn-ts/* packages must share one version, found: ${[...versions].map(([n, v]) => `${n}@${v}`).join(', ')}`);

if (errors.length) {
  console.error(`check-deps found ${errors.length} problem(s):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-deps: ${versions.size} packages OK (${[...distinct][0]})`);
