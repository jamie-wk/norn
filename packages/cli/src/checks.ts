import { declaresActivityCode, type Analyzer } from './analyze.js';
import { isBuiltin, isRelative, type Project } from './project.js';
import { patternNames, type AstNode, type ImportInfo, type ParsedModule } from './source.js';

/** Packages that cannot run in the Temporal workflow sandbox. */
export const WORKER_ONLY_PACKAGES: readonly string[] = [
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

const workerOnly = (specifier: string) => WORKER_ONLY_PACKAGES.find((p) => specifier === p || specifier.startsWith(`${p}/`));

function importText(imp: ImportInfo, typeOnly: boolean): string {
  const names = imp.specifiers.map((s) => (s.imported === s.local ? s.local : `${s.imported} as ${s.local}`)).join(', ');
  return `${imp.form === 'export' ? 'export' : 'import'}${typeOnly ? ' type' : ''} { ${names} } from '${imp.source}'`;
}

/**
 * Checks that workflow code (workflow files and every relative module they load) imports nothing
 * that cannot run in the workflow sandbox, and uses no non-deterministic globals.
 */
export function checkWorkflowCode(project: Project, analyzer: Analyzer, workflowFiles: readonly string[]): void {
  const reported = new Set<string>();
  const checked = new Set<string>();
  const report = (mod: ParsedModule, node: AstNode, message: string, hint: string) => {
    const key = `${mod.file}:${node.start}`;
    if (reported.has(key)) return;
    reported.add(key);
    analyzer.error('import-boundary', mod, node, message, hint);
  };

  for (const start of [...workflowFiles].sort()) {
    const queue: Array<{ file: string; chain: string[] }> = [{ file: start, chain: [start] }];
    const visited = new Set<string>([start]);
    while (queue.length > 0) {
      const { file, chain } = queue.shift()!;
      const mod = project.module(file);
      if (mod.errors.length > 0) continue;
      if (!checked.has(file)) {
        checked.add(file);
        checkDeterminism(mod, analyzer);
      }
      const via = chain.length > 1 ? ` (workflow code: ${chain.map((f) => project.rel(f)).join(' → ')})` : '';
      for (const imp of mod.imports) {
        if (imp.typeOnly) continue;
        const inline = imp.inlineTypeOnly;
        const inlineNote = inline
          ? `; ${importText(imp, false).replace(/\{ (.*) \}/, (_m, names: string) => `{ ${names.split(', ').map((n) => `type ${n}`).join(', ')} }`)} still loads the module under verbatimModuleSyntax`
          : '';
        const inlineHint = inline ? `Write ${importText(imp, true)} instead. ` : '';
        if (isBuiltin(imp.source)) {
          report(
            mod,
            imp.node,
            `Workflow code must not import the Node built-in "${imp.source}": the Temporal workflow sandbox has no Node APIs${inlineNote}${via}`,
            `${inlineHint}Move this work into an activity and call it with useActivities().`,
          );
          continue;
        }
        const denied = workerOnly(imp.source);
        if (denied) {
          report(
            mod,
            imp.node,
            `Workflow code must not import "${imp.source}": ${denied} only works outside the workflow sandbox${inlineNote}${via}`,
            `${inlineHint || 'Use import type for types; '}move runtime code into an activity.`,
          );
          continue;
        }
        if (!isRelative(imp.source)) continue;
        const target = project.resolve(file, imp.source);
        if (!target) continue;
        let targetMod: ParsedModule;
        try {
          targetMod = project.module(target);
        } catch {
          continue;
        }
        if (declaresActivityCode(targetMod)) {
          report(
            mod,
            imp.node,
            `Workflow code must not import ${project.rel(target)}, which declares @Activities or @Service classes${inlineNote}${via}`,
            inline ? `${inlineHint}Workflows reach activities through the generated activities file.` : 'Use import type for types; workflows call activities through the generated activities file with useActivities().',
          );
          continue;
        }
        if (!visited.has(target)) {
          visited.add(target);
          queue.push({ file: target, chain: [...chain, target] });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------------------------

const TEMPORAL_POLYFILL = /^(?:@js-temporal\/polyfill|temporal-polyfill)(?:\/.*)?$/;
const WATCHED = new Set(['setTimeout', 'setInterval', 'setImmediate', 'process', 'Temporal', 'crypto', 'performance', 'WeakRef', 'FinalizationRegistry']);

const MESSAGES: Record<string, [message: string, hint: string]> = {
  setTimeout: [
    'setTimeout in workflow code: the sandbox only emulates it with a durable timer, and a callback timer easily outlives the code that needed it',
    "Use await sleep(ms) from '@temporalio/workflow', or await condition(() => ..., timeout).",
  ],
  setInterval: ['setInterval does not exist in the Temporal workflow sandbox', "Use await sleep(ms) from '@temporalio/workflow' in a loop."],
  setImmediate: ['setImmediate does not exist in the Temporal workflow sandbox', "Use await sleep(ms) from '@temporalio/workflow'."],
  process: [
    'process is not available in the Temporal workflow sandbox, and host state differs between the original run and a replay',
    'Pass configuration in as workflow input, or read it in an activity.',
  ],
  'Temporal.Now': [
    'Temporal.Now reads the real wall clock, which the workflow sandbox does not make deterministic',
    'Derive time from workflow time, e.g. Temporal.Instant.fromEpochMilliseconds(Date.now()), or use workflowInfo() timestamps.',
  ],
  crypto: [
    'crypto is non-deterministic and Web Crypto is not available in the Temporal workflow sandbox',
    "Use uuid4() from '@temporalio/workflow' for IDs; do real cryptography in an activity.",
  ],
  performance: [
    'performance reads a real high-resolution clock that the workflow sandbox does not make deterministic',
    'Use Date.now(), which returns workflow time, or measure timings in an activity.',
  ],
  WeakRef: ['WeakRef throws a DeterminismViolationError in workflows: garbage collection timing is non-deterministic', 'Keep a strong reference.'],
  FinalizationRegistry: [
    'FinalizationRegistry throws a DeterminismViolationError in workflows: garbage collection timing is non-deterministic',
    'Keep the data in workflow state instead.',
  ],
};

/** Keys whose values are TypeScript-only and never evaluated. */
const TYPE_KEYS = new Set(['typeAnnotation', 'typeArguments', 'typeParameters', 'returnType', 'superTypeArguments', 'implements', 'decorators']);
const TS_EXPRESSIONS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression']);

type Scope = Set<string>;

function blockDeclarations(statements: AstNode[], scope: Scope): void {
  for (const raw of statements) {
    const stmt = raw.type === 'ExportNamedDeclaration' || raw.type === 'ExportDefaultDeclaration' ? (raw.declaration ?? raw) : raw;
    switch (stmt.type) {
      case 'VariableDeclaration':
        for (const d of stmt.declarations) for (const id of patternNames(d.id)) scope.add(id.name);
        break;
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
      case 'TSEnumDeclaration':
        if (stmt.id) scope.add(stmt.id.name);
        break;
      case 'ImportDeclaration':
        if (stmt.importKind !== 'type') for (const s of stmt.specifiers) if (s.importKind !== 'type') scope.add(s.local.name);
        break;
    }
  }
}

function checkDeterminism(mod: ParsedModule, analyzer: Analyzer): void {
  // `Temporal` imported from a polyfill still has a real-clock `Now`.
  const polyfillTemporal = new Set<string>();
  for (const [local, b] of mod.bindings) if (b.imported === 'Temporal' && TEMPORAL_POLYFILL.test(b.source)) polyfillTemporal.add(local);

  const bound = (scopes: Scope[], name: string) => scopes.some((s) => s.has(name));
  const report = (node: AstNode, key: string) => {
    const [message, hint] = MESSAGES[key]!;
    analyzer.error('determinism', mod, node, message, hint);
  };

  const visitReference = (node: AstNode, parent: AstNode | undefined, scopes: Scope[]) => {
    const name = node.name as string;
    if (!WATCHED.has(name)) return;
    const isTemporal = name === 'Temporal';
    if (bound(scopes, name) && !(isTemporal && polyfillTemporal.has(name))) return;
    if (isTemporal) {
      if (parent?.type === 'MemberExpression' && parent.object === node) {
        const prop = parent.computed ? parent.property.value : parent.property.name;
        if (prop === 'Now') report(parent, 'Temporal.Now');
      }
      return;
    }
    report(node, name);
  };

  const walk = (node: AstNode, parent: AstNode | undefined, key: string | undefined, scopes: Scope[]): void => {
    if (node.type.startsWith('TS') && !TS_EXPRESSIONS.has(node.type) && node.type !== 'TSParameterProperty' && node.type !== 'TSEnumDeclaration' && node.type !== 'TSModuleDeclaration' && node.type !== 'TSExportAssignment') {
      return;
    }
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') return;
    if (node.type === 'ExportNamedDeclaration' && node.exportKind === 'type') return;
    if (node.type === 'Identifier') {
      // Non-reference positions: property keys, member properties, labels, declarations.
      if (parent) {
        if ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed) || ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition' || parent.type === 'AccessorProperty') && key === 'key' && !parent.computed)) {
          return;
        }
        if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return;
        if (parent.type === 'ExportSpecifier') return;
      }
      visitReference(node, parent, scopes);
      return;
    }

    let inner = scopes;
    switch (node.type) {
      case 'Program':
      case 'BlockStatement':
      case 'StaticBlock': {
        const scope: Scope = new Set();
        blockDeclarations(node.body, scope);
        inner = [...scopes, scope];
        break;
      }
      case 'SwitchStatement': {
        const scope: Scope = new Set();
        for (const c of node.cases) blockDeclarations(c.consequent, scope);
        inner = [...scopes, scope];
        break;
      }
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const scope: Scope = new Set();
        if (node.type === 'FunctionExpression' && node.id) scope.add(node.id.name);
        for (const p of node.params) for (const id of patternNames(p)) scope.add(id.name);
        inner = [...scopes, scope];
        break;
      }
      case 'ClassExpression':
        if (node.id) inner = [...scopes, new Set([node.id.name])];
        break;
      case 'CatchClause': {
        const scope: Scope = new Set();
        for (const id of patternNames(node.param)) scope.add(id.name);
        inner = [...scopes, scope];
        break;
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const init = node.type === 'ForStatement' ? node.init : node.left;
        if (init?.type === 'VariableDeclaration') {
          const scope: Scope = new Set();
          for (const d of init.declarations) for (const id of patternNames(d.id)) scope.add(id.name);
          inner = [...scopes, scope];
        }
        break;
      }
    }

    for (const k in node) {
      if (k === 'type' || k === 'start' || k === 'end' || TYPE_KEYS.has(k)) continue;
      // Declared names are bindings, not references.
      if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && k === 'id') continue;
      if (node.type === 'VariableDeclarator' && k === 'id') {
        walkPatternDefaults(node.id, inner);
        continue;
      }
      if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && k === 'params') {
        for (const p of node.params) walkPatternDefaults(p, inner);
        continue;
      }
      if (node.type === 'CatchClause' && k === 'param') continue;
      const value = node[k];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === 'object' && typeof child.type === 'string') walk(child, node, k, inner);
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        walk(value, node, k, inner);
      }
    }
  };

  /** Walks only the default-value expressions inside a binding pattern. */
  const walkPatternDefaults = (pattern: AstNode | null, scopes: Scope[]): void => {
    if (!pattern) return;
    switch (pattern.type) {
      case 'AssignmentPattern':
        walkPatternDefaults(pattern.left, scopes);
        walk(pattern.right, pattern, 'right', scopes);
        break;
      case 'ObjectPattern':
        for (const p of pattern.properties) {
          if (p.type === 'RestElement') walkPatternDefaults(p.argument, scopes);
          else {
            if (p.computed) walk(p.key, p, 'key', scopes);
            walkPatternDefaults(p.value, scopes);
          }
        }
        break;
      case 'ArrayPattern':
        for (const el of pattern.elements) walkPatternDefaults(el, scopes);
        break;
      case 'RestElement':
        walkPatternDefaults(pattern.argument, scopes);
        break;
      case 'TSParameterProperty':
        walkPatternDefaults(pattern.parameter, scopes);
        break;
    }
  };

  walk(mod.program, undefined, undefined, []);
}
