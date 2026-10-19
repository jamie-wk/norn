import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as tsParser from '@typescript-eslint/parser';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import plugin, { defaultActivityPatterns, defaultAllow, defaultDeny, workflowFiles } from '../src/index.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };

describe('plugin', () => {
  it('exposes meta matching package.json', () => {
    expect(plugin.meta).toEqual({ name: pkg.name, version: pkg.version });
  });

  it('exposes both rules with docs and messages', () => {
    expect(Object.keys(plugin.rules).sort()).toEqual(['no-activity-imports', 'workflow-determinism']);
    for (const rule of Object.values(plugin.rules)) {
      expect(rule.meta?.type).toBe('problem');
      expect(rule.meta?.docs?.description).toBeTruthy();
      expect(rule.meta?.docs?.url).toMatch(/^https:\/\//);
      expect(Object.keys(rule.meta?.messages ?? {}).length).toBeGreaterThan(0);
    }
  });

  it('exports the default workflow file globs and option defaults', () => {
    expect(workflowFiles).toEqual(['**/*.workflow.ts', '**/workflows/**/*.ts', '**/.norn/workflows.ts']);
    expect(defaultAllow).toEqual(['@temporalio/workflow', '@temporalio/common', '@norn-ts/workflow', '@norn-ts/core']);
    expect(defaultActivityPatterns).toContain('**/activities/**');
    expect(defaultDeny).toEqual([
      '@temporalio/activity',
      '@temporalio/client',
      '@temporalio/worker',
      '@temporalio/testing',
      '@norn-ts/activity',
      '@norn-ts/worker',
      '@norn-ts/client',
      '@norn-ts/testing',
      '@norn-ts/hono',
      '@norn-ts/cli',
    ]);
  });
});

describe('configs.recommended', () => {
  const recommended = plugin.configs.recommended;

  it('registers both rules at error for the workflow file globs', () => {
    expect(recommended.name).toBe('@norn-ts/eslint-plugin/recommended');
    expect(recommended.files).toEqual(workflowFiles);
    expect(recommended.plugins).toEqual({ norn: plugin });
    expect(recommended.rules).toEqual({
      'norn/workflow-determinism': 'error',
      'norn/no-activity-imports': 'error',
    });
  });

  const linter = new Linter({ configType: 'flat', cwd: '/repo' });
  const config: Linter.Config[] = [{ files: ['**/*.ts'], languageOptions: { parser: tsParser } }, recommended];
  const code = `
import { readFileSync } from 'node:fs';
import { Workflow } from '@norn-ts/workflow';

@Workflow()
export class Orders {
  async run() { return [readFileSync('x'), Temporal.Now.instant()]; }
}
`;
  const lint = (file: string) =>
    linter.verify(code, config, { filename: path.join('/repo', file) }).map((m) => `${m.ruleId}:${m.severity}`);

  it.each(['src/orders.workflow.ts', 'src/workflows/orders.ts', 'src/workflows/nested/orders.ts', '.norn/workflows.ts', 'apps/api/.norn/workflows.ts'])(
    'lints %s',
    (file) => {
      expect(lint(file)).toEqual(['norn/no-activity-imports:2', 'norn/workflow-determinism:2']);
    },
  );

  it.each(['src/activities/payments.ts', 'src/orders.ts', 'src/orders.workflow.test.ts', '.norn/activities.ts'])('ignores %s', (file) => {
    expect(lint(file)).toEqual([]);
  });
});
