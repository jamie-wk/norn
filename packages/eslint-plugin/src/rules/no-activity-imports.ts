import { isBuiltin } from 'node:module';
import type { Rule } from 'eslint';
import { globToRegExp, normalizeSpecifier } from '../glob.js';
import { type Node, docsUrl, findVariable, staticString } from '../utils.js';

export interface NoActivityImportsOptions {
  /** Globs matched against the (loosely normalized) import specifier. Replaces the defaults. */
  activityPatterns?: string[];
  /** Specifiers (and their subpaths) that are never reported. Added to the default allow list; wins over `deny`. */
  allow?: string[];
  /** Packages (and their subpaths) that are always reported. Added to the default deny list. */
  deny?: string[];
  /** Report every bare package import that is not in the allow list. */
  onlyAllowed?: boolean;
}

/** Specifiers treated as activity or service code by default. */
export const defaultActivityPatterns: readonly string[] = [
  '**/activities/**',
  '**/services/**',
  '**/*.activities',
  '**/*.activities.ts',
  '**/*.activities.js',
  '**/*.service',
  '**/*.service.ts',
  '**/*.service.js',
];

/** Packages that are always safe to import from workflow code. */
export const defaultAllow: readonly string[] = ['@temporalio/workflow', '@temporalio/common', '@norn/workflow', '@norn/core'];

/** Packages that cannot run in the Temporal workflow sandbox, reported even without `onlyAllowed`. */
export const defaultDeny: readonly string[] = [
  '@temporalio/activity',
  '@temporalio/client',
  '@temporalio/worker',
  '@temporalio/testing',
  '@norn/activity',
  '@norn/worker',
  '@norn/client',
  '@norn/testing',
  '@norn/hono',
  '@norn/cli',
];

/** `specifier` is `name` or one of its subpaths. */
const matchesPackage = (specifier: string, names: readonly string[]) =>
  names.some((name) => specifier === name || specifier.startsWith(`${name}/`));

/** Relative, absolute, subpath-import (`#x`) and URL specifiers are not bare package names. */
const isBare = (specifier: string) => !/^(?:[./#]|[a-z][a-z0-9+.-]*:)/i.test(specifier);

type ImportLike = { importKind?: string; exportKind?: string };
const isTypeKind = (node: unknown) => {
  const n = node as ImportLike;
  return n.importKind === 'type' || n.exportKind === 'type';
};
/**
 * `import { type A, type B } from 'x'`: every specifier is an inline `type`. Under `verbatimModuleSyntax`
 * this compiles to `import {} from 'x'`, which still loads `x`.
 */
const allSpecifiersInlineType = (specifiers: readonly unknown[]) => specifiers.length > 0 && specifiers.every(isTypeKind);

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow loading Node built-ins, sandbox-incompatible packages and activity/service modules (and optionally any non-allowed package) from workflow code',
      recommended: true,
      url: docsUrl('no-activity-imports'),
    },
    schema: [
      {
        type: 'object',
        properties: {
          activityPatterns: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          allow: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          deny: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          onlyAllowed: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ activityPatterns: [...defaultActivityPatterns], allow: [], deny: [], onlyAllowed: false }],
    messages: {
      builtin:
        "Workflow code must not import the Node built-in '{{source}}': the Temporal workflow sandbox has no Node APIs and the workflow bundle will fail. Move this work into an activity and call it through `useActivities()`. Type-only imports (`import type`) are fine.",
      activity:
        "Workflow code must not import activity or service code ('{{source}}' matches '{{pattern}}'): it would run inside the deterministic sandbox instead of as an activity. Call it through an activity contract with `useActivities()`, and use `import type` if you only need its types.",
      denied:
        "Workflow code must not import '{{source}}': it cannot run in the Temporal workflow sandbox (it is on this rule's deny list). Use it from activities, the worker or the client instead, and use `import type` if you only need its types.",
      inlineTypeOnly:
        "'{{source}}' is still loaded at runtime: every specifier here is an inline `type`, but under `verbatimModuleSyntax` this compiles to `{{keyword}} {} from '{{source}}'`, and workflow code must not load this module. Use `{{keyword}} type { ... } from '{{source}}'` instead.",
      notAllowed:
        "'{{source}}' is not in this rule's allow list for workflow code (`onlyAllowed` is on). If it is deterministic and sandbox-safe, add it to the `allow` option; otherwise move its use into an activity.",
    },
  },

  create(context) {
    const [options = {}] = context.options as [NoActivityImportsOptions?];
    const patterns = (options.activityPatterns ?? defaultActivityPatterns).map((glob) => ({ glob, re: globToRegExp(glob) }));
    const allow = [...defaultAllow, ...(options.allow ?? [])];
    const onlyAllowed = options.onlyAllowed ?? false;
    const sourceCode = context.sourceCode;

    const deny = [...defaultDeny, ...(options.deny ?? [])];

    /** Why `source` must not be loaded from workflow code, if it must not. */
    const problem = (source: string): { messageId: string; data: Record<string, string> } | undefined => {
      if (matchesPackage(source, allow)) return undefined;
      if (isBuiltin(source)) return { messageId: 'builtin', data: { source } };
      if (matchesPackage(source, deny)) return { messageId: 'denied', data: { source } };
      const normalized = normalizeSpecifier(source);
      const match = patterns.find((p) => p.re.test(normalized));
      if (match) return { messageId: 'activity', data: { source, pattern: match.glob } };
      if (onlyAllowed && isBare(source)) return { messageId: 'notAllowed', data: { source } };
      return undefined;
    };

    /** Reports the module `sourceNode` names; `inlineType` marks a declaration whose specifiers are all inline `type`. */
    const check = (sourceNode: unknown, inlineType?: 'import' | 'export') => {
      const source = staticString(sourceNode);
      const found = source === undefined ? undefined : problem(source);
      if (!found) return;
      const node = sourceNode as Node;
      if (inlineType) context.report({ node, messageId: 'inlineTypeOnly', data: { source: source!, keyword: inlineType } });
      else context.report({ node, ...found });
    };

    return {
      ImportDeclaration(node) {
        if (isTypeKind(node)) return;
        check(node.source, allSpecifiersInlineType(node.specifiers) ? 'import' : undefined);
      },
      ExportNamedDeclaration(node) {
        if (!node.source || isTypeKind(node)) return;
        check(node.source, allSpecifiersInlineType(node.specifiers) ? 'export' : undefined);
      },
      ExportAllDeclaration(node) {
        if (!isTypeKind(node)) check(node.source);
      },
      ImportExpression(node) {
        check(node.source);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'Identifier' || callee.name !== 'require' || node.arguments.length === 0) return;
        // A locally declared `require` (a parameter, say) is not Node's.
        const variable = findVariable(sourceCode, node, 'require');
        if (variable && variable.defs.length > 0) return;
        check(node.arguments[0]);
      },
      // TypeScript's `import x = require('y')`.
      TSImportEqualsDeclaration(node: unknown) {
        const n = node as ImportLike & { moduleReference: { type: string; expression?: unknown } };
        if (isTypeKind(n) || n.moduleReference.type !== 'TSExternalModuleReference') return;
        check(n.moduleReference.expression);
      },
    } as Rule.RuleListener;
  },
};

export default rule;
