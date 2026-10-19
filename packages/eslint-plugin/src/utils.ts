import type { Rule, Scope, SourceCode } from 'eslint';

export type Node = Rule.Node;
export type NodeOf<T extends Node['type']> = Extract<Node, { type: T }>;
export type MemberExpression = NodeOf<'MemberExpression'>;

/** Rule documentation: the README section headed `norn/<rule>` (GitHub drops the `/` from the anchor). */
export const docsUrl = (rule: string) => `https://github.com/jamie-wk/norn/tree/main/packages/eslint-plugin#norn${rule}`;

/** The static value of a string literal or an expression-free template literal. */
export function staticString(node: unknown): string | undefined {
  const n = node as { type?: string; value?: unknown; expressions?: unknown[]; quasis?: { value: { cooked?: string | null } }[] };
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral' && n.expressions?.length === 0) return n.quasis?.[0]?.value.cooked ?? undefined;
  return undefined;
}

/** The property name of `a.b` or `a['b']`, if it is static. */
export function propertyName(node: MemberExpression): string | undefined {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  return node.computed ? staticString(node.property) : undefined;
}

/** `node.parent` when it is a member expression whose object is `node` (`node.x` / `node['x']`). */
export function parentMember(node: Node): MemberExpression | undefined {
  const parent = node.parent;
  return parent?.type === 'MemberExpression' && parent.object === node ? parent : undefined;
}

/** Objects through which globals can also be reached, as in `globalThis.process`. */
const globalObjects = ['globalThis', 'window', 'self', 'global'];

/** A use of a global (by name) and the node standing for it: an identifier, or a `globalThis.name` member. */
export interface GlobalUse {
  name: string;
  node: Node;
}

/** Whether `ref` sits in a TypeScript type position (`let x: T`, `typeof x`), which never runs. */
function isTypeOnly(ref: Scope.Reference): boolean {
  const tsRef = ref as Scope.Reference & { isValueReference?: boolean };
  if (tsRef.isValueReference === false) return true;
  const parent = (ref.identifier as Node).parent as { type: string } | undefined;
  return parent?.type === 'TSQualifiedName' || parent?.type === 'TSTypeQuery';
}

/**
 * References in the file to the global variables `names` (directly, or via `globalThis.name`),
 * skipping any that are shadowed by a local declaration and any in type positions.
 */
export function findGlobalUses(sourceCode: SourceCode, names: ReadonlySet<string>): GlobalUse[] {
  const globalScope = sourceCode.scopeManager.globalScope;
  if (!globalScope) return [];
  const refs = new Set<Scope.Reference>();
  const collect = (name: string) => {
    for (const ref of globalScope.through) if (ref.identifier.name === name) refs.add(ref);
    // Configured or implicit globals (no declaration in the file) resolve to a definition-less global variable.
    const variable = globalScope.set.get(name);
    if (variable && variable.defs.length === 0) for (const ref of variable.references) refs.add(ref);
  };
  for (const name of [...names, ...globalObjects]) collect(name);

  const uses: GlobalUse[] = [];
  for (const ref of refs) {
    if (isTypeOnly(ref)) continue;
    const identifier = ref.identifier as Node & { name: string };
    if (names.has(identifier.name)) {
      uses.push({ name: identifier.name, node: identifier });
      continue;
    }
    const member = parentMember(identifier);
    const name = member && propertyName(member);
    if (member && name && names.has(name)) uses.push({ name, node: member });
  }
  return uses.sort((a, b) => a.node.range![0] - b.node.range![0]);
}

/** The variable `name` refers to at `node`, walking up from the innermost scope. */
export function findVariable(sourceCode: SourceCode, node: Node, name: string): Scope.Variable | undefined {
  for (let scope: Scope.Scope | null = sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(name);
    if (variable) return variable;
  }
  return undefined;
}
