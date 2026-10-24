import { afterAll, describe, expect, it } from 'vitest';
import { generate } from '../src/index.ts';
import { expectError, project, removeDir } from './helpers.ts';

const dirs: string[] = [];
afterAll(() => dirs.forEach(removeDir));
async function gen(files: Record<string, string>) {
  const dir = project(files);
  dirs.push(dir);
  return generate({ cwd: dir, write: false });
}

describe('decorator recognition', () => {
  it('follows import aliases and namespace imports, and ignores other decorators', async () => {
    const { errors, files } = await gen({
      'src/w.ts': `import { Workflow as Flow, Signal as On } from '@norn-ts/workflow';
import * as nw from '@norn-ts/workflow';
import { Injectable } from 'some-di';

@Injectable()
@Flow({ taskQueue: 'q' } as const)
export class AliasWorkflow {
  @On('go-now') go() {}
  @nw.Query() peek() { return 1; }
  async run() {}
}
`,
      'src/t.ts': `import type { Workflow } from '@norn-ts/workflow';
// A type-only import cannot decorate anything at runtime, so this class is not a workflow.
declare const Workflow: (o: unknown) => (c: unknown) => void;
@Workflow({ taskQueue: 'q' })
export class NotDetected { async run() {} }
`,
    });
    expect(errors).toEqual([]);
    expect(files['.norn/contracts.ts']).toContain("signals: { go: 'go-now' }");
    expect(files['.norn/contracts.ts']).toContain("queries: { peek: 'peek' }");
    expect(files['.norn/workflows.ts']).not.toContain('NotDetected');
  });

  it('strips JSDoc tags from handler descriptions and prefers explicit descriptions', async () => {
    const { errors, files } = await gen({
      'src/w.ts': `import { Workflow, Signal } from '@norn-ts/workflow';

@Workflow({ taskQueue: 'q' })
export class DocWorkflow {
  /**
   * Stops the job
   * as soon as possible.
   * @param reason why
   */
  @Signal() stop(_reason: string) {}

  /** Ignored: the option wins. */
  @Signal({ description: 'Explicit' }) other() {}

  // Not JSDoc.
  @Signal() plain() {}
  async run() {}
}
`,
    });
    expect(errors).toEqual([]);
    expect(files['.norn/workflows.ts']).toContain("descriptions: { stop: 'Stops the job as soon as possible.' },");
  });
});

describe('dependencies', () => {
  it('resolves namespace-qualified types, default values and local tokens', async () => {
    const { errors, files } = await gen({
      'src/tokens.ts': "import { token } from '@norn-ts/activity';\nexport interface Db { q(): void }\nexport const Db = token<Db>('Db');\n",
      'src/svc.ts': `import { Service, token } from '@norn-ts/activity';
import * as tokens from './tokens.js';
import * as pg from 'pg';

export interface Clock { now(): number }
export const Clock = token<Clock>('Clock');

@Service()
export class Repo {
  constructor(readonly db: tokens.Db, readonly pool: pg.Pool, readonly clock: Clock = { now: () => 0 }) {}
}
`,
    });
    expect(errors).toEqual([]);
    const container = files['.norn/container.ts']!;
    expect(container).toContain("import { Pool } from 'pg';");
    expect(container).toContain("import { Db } from '../src/tokens.js';");
    expect(container).toContain("import { Clock, Repo } from '../src/svc.js';");
    expect(container).toContain('{ cls: Repo, deps: [Db, Pool, Clock] }');
  });

  it('inherits @Activity methods and the constructor from a base class', async () => {
    const { errors, files } = await gen({
      'src/base.ts': `import { Activity, NonRetryable } from '@norn-ts/activity';
import { Db } from './db.js';
export class BaseActivities {
  constructor(protected readonly db: Db) {}
  @Activity({ timeout: '5s' }) @NonRetryable([TypeError]) async ping() { return 'pong'; }
}
`,
      'src/db.ts': '@Reflectable()\nexport class Db {}\ndeclare function Reflectable(): (c: unknown) => void;\n',
      'src/acts.ts': `import { Activities, Activity } from '@norn-ts/activity';
import { BaseActivities } from './base.js';
@Activities({ prefix: 'x.' })
export class XActivities extends BaseActivities {
  @Activity() async work() {}
}
`,
    });
    expect(errors).toEqual([]);
    expect(files['.norn/activities.ts']).toContain("methods: { ping: { timeout: '5s', nonRetryable: ['TypeError'] }, work: {} }");
    expect(files['.norn/container.ts']).toContain('{ cls: XActivities, deps: [Db] }');
    expect(files['.norn/registry.ts']).toContain("activities: ['x.ping', 'x.work']");
  });

  it('uses inject over parameter types and checks every entry', async () => {
    const { errors } = await gen({
      'src/acts.ts': `import { Activities, Activity } from '@norn-ts/activity';
@Activities({ inject: [Nowhere, 'Db'] })
export class Acts {
  constructor(x: string) {}
  @Activity() async a() {}
}
`,
    });
    expectError(errors, { code: 'invalid-option', file: 'src/acts.ts', line: 2, message: 'inject must list classes or tokens' });
    expect(errors).toHaveLength(1);
  });

  it('requires local dependency values to be exported', async () => {
    const { errors } = await gen({
      'src/svc.ts': `import { Service } from '@norn-ts/activity';
class Hidden {}
@Service()
export class Svc {
  constructor(readonly hidden: Hidden) {}
}
`,
    });
    expectError(errors, { code: 'not-exported', line: 5, message: 'Hidden (used by Svc) must be exported' });
    expect(errors).toHaveLength(1);
  });
});

describe('option validation', () => {
  it('rejects unknown and mistyped options', async () => {
    const { errors } = await gen({
      'src/acts.ts': `import { Activities, Activity, Service } from '@norn-ts/activity';
@Activities()
export class Acts {
  @Activity({ timout: '1s' }) async a() {}
  @Activity({ retries: -1, retry: { maximumAttempts: 2, jitter: 1 }, local: 'yes' }) async b() {}
  @Activity({ timeout: '' }) async c() {}
}
@Service({ provides: 'Token' })
export class Svc {}
`,
      'src/w.ts': `import { Workflow, Signal, Update } from '@norn-ts/workflow';
@Workflow({ taskQueue: 'q', retries: 3, description: 'W' })
export class W {
  @Signal({ unfinishedPolicy: 'explode', dedupeBy: 'id' }) s() {}
  @Update({ name: '' }) u() {}
  @Signal(42) t() {}
  async run() {}
}
`,
    });
    expectError(errors, { code: 'invalid-option', line: 4, message: '@Activity has no option "timout"' });
    expectError(errors, { code: 'invalid-option', line: 5, message: '"retries" must be a non-negative integer' });
    expectError(errors, { code: 'invalid-option', line: 5, message: 'has no field "jitter"' });
    expectError(errors, { code: 'invalid-option', line: 5, message: '"local" must be a boolean' });
    expectError(errors, { code: 'invalid-option', line: 5, message: 'cannot be combined with retry.maximumAttempts' });
    expectError(errors, { code: 'invalid-option', line: 6, message: 'timeout: Invalid duration' });
    expectError(errors, { code: 'invalid-option', line: 8, message: 'provides must be a class or token' });
    expectError(errors, { code: 'invalid-option', file: 'src/w.ts', line: 2, message: '@Workflow has no option "retries"' });
    expectError(errors, { code: 'invalid-option', file: 'src/w.ts', line: 2, message: '@Workflow has no option "description"' });
    expectError(errors, { code: 'invalid-option', file: 'src/w.ts', line: 4, message: 'unfinishedPolicy' });
    expectError(errors, { code: 'invalid-option', file: 'src/w.ts', line: 4, message: 'dedupeBy must be a function' });
    expectError(errors, { code: 'invalid-option', file: 'src/w.ts', line: 5, message: 'name must be a non-empty string' });
    expectError(errors, { code: 'invalid-option', file: 'src/w.ts', line: 6, message: 'takes a name or an options object' });
    expect(errors).toHaveLength(13);
  });

  it('allows functions only for dedupeBy', async () => {
    const { errors } = await gen({
      'src/acts.ts': `import { Activities, Activity } from '@norn-ts/activity';
@Activities()
export class Acts {
  @Activity({ name: () => 'x' }) async a() {}
}
`,
    });
    expectError(errors, { code: 'non-literal', line: 4, message: 'Functions are only allowed for options such as dedupeBy' });
    expect(errors).toHaveLength(1);
  });
});
