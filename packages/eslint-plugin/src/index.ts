import type { ESLint, Linter, Rule } from 'eslint';
import noActivityImports from './rules/no-activity-imports.js';
import workflowDeterminism from './rules/workflow-determinism.js';

export { defaultActivityPatterns, defaultAllow, defaultDeny } from './rules/no-activity-imports.js';
export type { NoActivityImportsOptions } from './rules/no-activity-imports.js';
export type { WorkflowDeterminismOptions } from './rules/workflow-determinism.js';

/** Files the recommended config treats as workflow code. */
export const workflowFiles: string[] = ['**/*.workflow.ts', '**/workflows/**/*.ts', '**/.norn/workflows.ts'];

const rules = {
  'workflow-determinism': workflowDeterminism,
  'no-activity-imports': noActivityImports,
} satisfies Record<string, Rule.RuleModule>;

export interface NornPlugin extends ESLint.Plugin {
  meta: { name: string; version: string };
  rules: typeof rules;
  configs: { recommended: Linter.Config };
}

const plugin: NornPlugin = {
  meta: { name: '@norn/eslint-plugin', version: '1.0.0' },
  rules,
  configs: {} as NornPlugin['configs'],
};

plugin.configs.recommended = {
  name: '@norn/eslint-plugin/recommended',
  files: workflowFiles,
  plugins: { norn: plugin },
  rules: {
    'norn/workflow-determinism': 'error',
    'norn/no-activity-imports': 'error',
  },
};

export default plugin;
