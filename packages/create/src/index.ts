import { spawn } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface CreateIo {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Asks for the project name when none is given. Without it, a missing name is a usage error. */
  prompt?: (question: string) => Promise<string>;
  /** Runs a command; resolves with its exit code. Defaults to spawning it with inherited stdio. */
  run?: (command: string, args: string[], options: { cwd: string }) => Promise<number>;
}

const USAGE = `Usage: pnpm create @norn-ts <project-name> [options]
       npm create @norn-ts@latest <project-name> [options]

Creates a Norn project: an order workflow, an activity with an injected service, a worker,
a client script and a test. Use "." to create it in the current (empty) directory.

Options:
  --force        Write into a directory that is not empty (existing files with the same names are replaced)
  --no-install   Skip installing dependencies and running norn gen
  -h, --help     Show this help`;

const templateDir = fileURLToPath(new URL('../template', import.meta.url));
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

// npm never publishes files named .gitignore, so the template stores them under another name.
const RENAMES: Record<string, string> = { _gitignore: '.gitignore' };

/** The package manager that launched this process, from the `npm_config_user_agent` it sets. */
export function packageManagerFrom(userAgent: string | undefined): PackageManager {
  const name = userAgent?.split('/')[0];
  return name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : 'npm';
}

/** Why `name` is not a valid npm package name for a new project, or undefined if it is. */
function invalidName(name: string): string | undefined {
  if (!name) return 'The project name is empty.';
  if (name.length > 214) return 'The project name is longer than 214 characters.';
  if (!/^[a-z0-9][a-z0-9._~-]*$/.test(name)) {
    return `"${name}" is not a valid package name: use lowercase letters, digits, "-", "." and "_", starting with a letter or digit.`;
  }
  return undefined;
}

const defaultRun: NonNullable<CreateIo['run']> = (command, args, { cwd }) =>
  new Promise((done) => {
    // shell on Windows so npm/pnpm resolve to their .cmd shims
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', () => done(1));
    child.on('close', (code) => done(code ?? 1));
  });

export async function main(argv: string[], io: CreateIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const run = io.run ?? defaultRun;

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: { force: { type: 'boolean' }, install: { type: 'boolean', default: true }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (error) {
    stderr(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    stdout(`${USAGE}\n`);
    return 0;
  }
  if (positionals.length > 1) {
    stderr(`Expected one project name, got ${positionals.length}.\n\n${USAGE}\n`);
    return 2;
  }

  let target = positionals[0];
  if (target === undefined) {
    if (!io.prompt) {
      stderr(`Missing the project name.\n\n${USAGE}\n`);
      return 2;
    }
    target = (await io.prompt('Project name: ')).trim();
  }

  const dir = resolve(cwd, target);
  // The project is named after the directory, so "." and "apps/billing" work too.
  const name = target && basename(dir);
  const problem = invalidName(name);
  if (problem) {
    stderr(`${problem}\n`);
    return 1;
  }
  if (existsSync(dir) && readdirSync(dir).length > 0 && !values.force) {
    stderr(`${relative(cwd, dir) || dir} is not empty. Choose another name, or pass --force to write into it anyway.\n`);
    return 1;
  }

  cpSync(templateDir, dir, { recursive: true });
  for (const [from, to] of Object.entries(RENAMES)) {
    if (existsSync(join(dir, from))) renameSync(join(dir, from), join(dir, to));
  }
  for (const file of ['package.json', 'README.md']) {
    const path = join(dir, file);
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('{{name}}', name).replaceAll('{{version}}', version));
  }

  const pm = packageManagerFrom(env.npm_config_user_agent);
  const runScript = (script: string) => (pm === 'npm' || pm === 'bun' ? `${pm} run ${script}` : `${pm} ${script}`);
  stdout(`\nCreated ${name} in ${dir}\n`);

  if (values.install) {
    for (const args of [['install'], ['run', 'gen']]) {
      if ((await run(pm, args, { cwd: dir })) !== 0) {
        stderr(`\n${pm} ${args.join(' ')} failed. Fix the problem above, then run it again in ${dir}.\n`);
        return 1;
      }
    }
  }

  const steps = [...(dir === cwd ? [] : [`cd ${relative(cwd, dir)}`]), ...(values.install ? [] : [`${pm} install`]), runScript('dev')];
  stdout(
    `\nNext steps:\n\n${steps.map((s) => `  ${s}`).join('\n')}\n\n` +
      `That starts a local Temporal server (or uses one on localhost:7233) and the worker.\n` +
      `Then, in another terminal, start an order with \`${runScript('order')}\`, and watch it at http://localhost:8233.\n\n` +
      `Docs: https://jamie-wk.github.io/norn/\n`,
  );
  return 0;
}
