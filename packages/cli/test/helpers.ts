import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { NornGenError } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path of a fixture directory. */
export function fixture(name: string): string {
  return join(here, 'fixtures', name);
}

/**
 * Temporary projects live under packages/cli/test/.tmp so `@norn/*` imports (and the
 * `@norn/cli` self-reference in norn.config.ts) resolve exactly as they do for the fixtures.
 */
export function tempDir(prefix = 'project'): string {
  const root = join(here, '.tmp');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, `${prefix}-`));
}

export function copyFixture(name: string): string {
  const dir = tempDir(name.replaceAll('/', '-'));
  cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

export function writeFiles(dir: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

export function project(files: Record<string, string>): string {
  return writeFiles(tempDir(), files);
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface ExpectedError {
  code: string;
  file?: string;
  line?: number;
  column?: number;
  message?: string | RegExp;
}

/** Asserts that exactly one error matches. */
export function expectError(errors: readonly NornGenError[], expected: ExpectedError): NornGenError {
  const matches = errors.filter(
    (e) =>
      e.code === expected.code &&
      (expected.file === undefined || e.file === expected.file) &&
      (expected.line === undefined || e.line === expected.line) &&
      (expected.column === undefined || e.column === expected.column) &&
      (expected.message === undefined ||
        (typeof expected.message === 'string' ? e.message.includes(expected.message) : expected.message.test(e.message))),
  );
  expect(matches, `expected one error matching ${JSON.stringify(expected, (_k, v) => (v instanceof RegExp ? String(v) : v))} in:\n${errors.map((e) => `  ${e.code} ${e.file}:${e.line}:${e.column} ${e.message}`).join('\n')}`).toHaveLength(1);
  return matches[0]!;
}

/** The 1-based line and column of the `occurrence`-th `needle` in a fixture file. */
export function at(fixtureName: string, file: string, needle: string, occurrence = 1): { file: string; line: number; column: number } {
  const text = readFileSync(join(fixture(fixtureName), file), 'utf8');
  let index = -1;
  for (let i = 0; i < occurrence; i++) {
    index = text.indexOf(needle, index + 1);
    if (index === -1) throw new Error(`"${needle}" (#${occurrence}) not found in ${fixtureName}/${file}`);
  }
  const before = text.slice(0, index).split('\n');
  return { file, line: before.length, column: before.at(-1)!.length + 1 };
}
