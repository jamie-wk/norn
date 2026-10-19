import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { bundle } from './bundle.js';
import { loadConfig } from './config.js';
import { NornGenFailure, formatError, type NornGenError } from './errors.js';
import { generate, type GenerateResult } from './generate.js';
import { pullHistories } from './histories.js';
import { readSchedules, syncSchedules } from './schedules.js';
import { connect, type Env } from './temporal.js';
import { watch } from './watch.js';

export interface CliIo {
  cwd?: string;
  env?: Env;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Stops `gen --watch`. Defaults to SIGINT / SIGTERM. */
  signal?: AbortSignal;
}

const USAGE = `Usage: norn <command> [options]

Commands:
  gen               Generate .norn/ (workflows, activities, contracts, container, registry) and norn.lock.json
  schedules sync    Create, update and (with --prune) delete Temporal schedules declared with @Schedule
  histories pull    Download workflow histories as JSON for replay tests
  bundle            Bundle the generated workflows for production workers

Options:
  -h, --help        Show help (also: norn <command> --help)
  -v, --version     Show the version

Exit codes: 0 success, 1 errors or stale files, 2 usage error.`;

const HELP: Record<string, string> = {
  gen: `Usage: norn gen [--check] [--watch] [--accept-rename] [--config <path>]

Reads @Workflow, @Activities and @Service classes (without running them) and writes:
  <outDir>/workflows.ts, activities.ts, contracts.ts, container.ts, registry.ts,
  search-attributes.json, schedules.json, and norn.lock.json next to norn.config.ts.

Options:
  --check           Compare with the files on disk; exit 1 if any are missing or stale. Writes nothing.
  --watch           Regenerate whenever a source file changes.
  --accept-rename   Accept workflow, handler or activity names removed from norn.lock.json.
  --config <path>   Use this config file instead of the nearest norn.config.ts.`,
  'schedules sync': `Usage: norn schedules sync [--dry-run] [--prune] [--config <path>]

Makes the namespace's schedules match <outDir>/schedules.json. Schedules created by norn are
marked with the memo { nornManaged: '<package.json name>' }; others, including other projects',
are never touched.

Options:
  --dry-run         Print the plan without changing anything.
  --prune           Delete this project's norn-managed schedules that are no longer declared.
  --config <path>   Use this config file.

Environment: TEMPORAL_ADDRESS (localhost:7233), TEMPORAL_NAMESPACE (default),
TEMPORAL_API_KEY (enables TLS), TEMPORAL_TLS_CERT and TEMPORAL_TLS_KEY (mTLS file paths).`,
  'histories pull': `Usage: norn histories pull <workflowId...> [--out <dir>]

Writes <dir>/<workflowId>.json (default dir: histories) for each workflow's latest run, for
replay tests with Worker.runReplayHistory. Connects like norn schedules sync.`,
  bundle: `Usage: norn bundle [--out <file>] [--codec] [--config <path>]

Bundles <outDir>/workflows.(ts|js) with Norn's bundler settings and workflow interceptors.

Options:
  --out <file>      Output file. Defaults to dist/workflow-bundle.js.
  --codec           Include @norn-ts/codec's payload converter.
  --config <path>   Use this config file.`,
};

class UsageError extends Error {}

function version(): string {
  // src/cli.ts and dist/cli.js both sit one level below package.json.
  return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

function parse<O extends NonNullable<ParseArgsConfig['options']>>(args: string[], options: O, positionals = false) {
  try {
    return parseArgs({ args, options: { help: { type: 'boolean', short: 'h' }, ...options }, allowPositionals: positionals, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Runs the norn CLI and resolves with the exit code. `bin.ts` is a thin wrapper around this. */
export async function main(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const cwd = resolve(io.cwd ?? process.cwd());
  const env = io.env ?? process.env;
  const out = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const err = io.stderr ?? ((text: string) => void process.stderr.write(text));
  const print = (text: string) => out(`${text}\n`);
  const fail = (text: string) => err(`${text}\n`);
  const printErrors = (errors: readonly NornGenError[]) => {
    fail(errors.map(formatError).join('\n\n'));
    fail(`\nFound ${plural(errors.length, 'error')}.`);
  };

  const [command, ...rest] = argv;
  try {
    if (command === undefined) {
      fail(USAGE);
      return 2;
    }
    if (command === '--help' || command === '-h' || command === 'help') {
      print(rest[0] && HELP[rest.join(' ')] ? HELP[rest.join(' ')]! : USAGE);
      return 0;
    }
    if (command === '--version' || command === '-v') {
      print(version());
      return 0;
    }

    switch (command) {
      case 'gen': {
        const { values, positionals } = parse(rest, {
          check: { type: 'boolean' },
          watch: { type: 'boolean' },
          'accept-rename': { type: 'boolean' },
          config: { type: 'string' },
        });
        if (values.help) return (print(HELP.gen!), 0);
        if (positionals.length > 0) throw new UsageError(`Unexpected argument "${positionals[0]}"`);
        if (values.check && values.watch) throw new UsageError('--check and --watch cannot be combined');
        const options = { cwd, configPath: values.config, acceptRename: values['accept-rename'] };

        const report = (result: GenerateResult): number => {
          if (result.errors.length > 0) {
            printErrors(result.errors);
            return 1;
          }
          if (values.check) {
            if (result.stale.length === 0) {
              print('All generated files are up to date.');
              return 0;
            }
            fail(`These generated files are out of date:\n${result.stale.map((f) => `  ${f}`).join('\n')}\n\nRun norn gen to update them.`);
            return 1;
          }
          if (result.written.length === 0) print('Generated files are up to date.');
          for (const file of result.written) print(`wrote ${file}`);
          return 0;
        };

        if (values.watch) {
          const controller = new AbortController();
          const stop = () => controller.abort();
          const signal = io.signal ?? controller.signal;
          if (!io.signal) {
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
          }
          try {
            await watch({ ...options, signal, onResult: (result) => void report(result) });
          } finally {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
          }
          return 0;
        }
        return report(await generate({ ...options, check: values.check }));
      }

      case 'schedules': {
        const [sub, ...args] = rest;
        if (sub === '--help' || sub === '-h') return (print(HELP['schedules sync']!), 0);
        if (sub !== 'sync') throw new UsageError(sub ? `Unknown command "schedules ${sub}"` : 'Missing subcommand: norn schedules sync');
        const { values, positionals } = parse(args, { 'dry-run': { type: 'boolean' }, prune: { type: 'boolean' }, config: { type: 'string' } });
        if (values.help) return (print(HELP['schedules sync']!), 0);
        if (positionals.length > 0) throw new UsageError(`Unexpected argument "${positionals[0]}"`);
        const config = await loadConfig({ cwd, configPath: values.config });
        const schedules = readSchedules(join(config.outDir, 'schedules.json'));
        const pkg = join(config.root, 'package.json');
        const project = existsSync(pkg) ? (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name : undefined;
        if (typeof project !== 'string' || project === '') throw new Error(`${pkg} needs a "name": schedules sync marks the schedules it manages with it`);
        const temporal = await connect(env);
        try {
          const dryRun = values['dry-run'] ?? false;
          const result = await syncSchedules({ client: temporal.client, project, schedules, dryRun, prune: values.prune ?? false });
          const verb = (past: string) => (dryRun ? `would be ${past}` : past);
          for (const id of result.created) print(`created    ${id}`);
          for (const id of result.updated) print(`updated    ${id}`);
          for (const id of result.unchanged) print(`unchanged  ${id}`);
          for (const id of result.deleted) print(`deleted    ${id}`);
          for (const id of result.conflicts) fail(`conflict   ${id}: a schedule with this id exists but was not created by norn for ${project}; delete it or change the id`);
          print(
            `${dryRun ? 'Dry run: ' : ''}${result.created.length} ${verb('created')}, ${result.updated.length} ${verb('updated')}, ` +
              `${result.unchanged.length} unchanged, ${result.deleted.length} ${verb('deleted')} in namespace ${temporal.namespace}.`,
          );
          return result.conflicts.length > 0 ? 1 : 0;
        } finally {
          await temporal.close();
        }
      }

      case 'histories': {
        const [sub, ...args] = rest;
        if (sub === '--help' || sub === '-h') return (print(HELP['histories pull']!), 0);
        if (sub !== 'pull') throw new UsageError(sub ? `Unknown command "histories ${sub}"` : 'Missing subcommand: norn histories pull <workflowId...>');
        const { values, positionals } = parse(args, { out: { type: 'string' } }, true);
        if (values.help) return (print(HELP['histories pull']!), 0);
        if (positionals.length === 0) throw new UsageError('norn histories pull needs at least one workflow ID');
        const temporal = await connect(env);
        try {
          const files = await pullHistories({ client: temporal.client, workflowIds: positionals, outDir: resolve(cwd, values.out ?? 'histories') });
          for (const file of files) print(`wrote ${relative(cwd, file) || file}`);
          return 0;
        } finally {
          await temporal.close();
        }
      }

      case 'bundle': {
        const { values, positionals } = parse(rest, { out: { type: 'string' }, codec: { type: 'boolean' }, config: { type: 'string' } });
        if (values.help) return (print(HELP.bundle!), 0);
        if (positionals.length > 0) throw new UsageError(`Unexpected argument "${positionals[0]}"`);
        const config = await loadConfig({ cwd, configPath: values.config });
        const result = await bundle({ outDir: config.outDir, outFile: resolve(cwd, values.out ?? 'dist/workflow-bundle.js'), codec: values.codec ?? false });
        print(`wrote ${relative(cwd, result.outFile)} (${Math.round(result.code.length / 1024)} KiB) from ${relative(cwd, result.workflowsPath)}`);
        return 0;
      }

      default:
        throw new UsageError(`Unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      fail(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (error instanceof NornGenFailure) {
      printErrors(error.errors);
      return 1;
    }
    fail(`error: ${(error as Error)?.message ?? String(error)}`);
    return 1;
  }
}
