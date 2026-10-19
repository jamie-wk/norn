import { parseSync } from 'oxc-parser';

/** A loosely typed ESTree/TS-ESTree node from oxc-parser. */
export interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: any;
}

export interface Comment {
  type: 'Line' | 'Block';
  value: string;
  start: number;
  end: number;
}

export interface ImportSpecifierInfo {
  /** Exported name in the target module: a name, `'default'` or `'*'` for namespaces. */
  imported: string;
  local: string;
  typeOnly: boolean;
}

export interface ImportInfo {
  source: string;
  node: AstNode;
  /** `import x`, `export ... from` or a dynamic `import()`. */
  form: 'import' | 'export' | 'dynamic';
  /** `import type` / `export type`: erased entirely. */
  typeOnly: boolean;
  /** `import { type A, type B }`: every specifier is inline `type`, which still loads the module. */
  inlineTypeOnly: boolean;
  specifiers: ImportSpecifierInfo[];
}

export interface Binding {
  source: string;
  imported: string;
  typeOnly: boolean;
}

export interface LocalDeclaration {
  kind: 'class' | 'function' | 'variable' | 'interface' | 'type' | 'enum' | 'namespace';
  node: AstNode;
  hasValue: boolean;
}

export type ExportEntry =
  | { kind: 'local'; local: string; typeOnly: boolean }
  | { kind: 'reexport'; source: string; imported: string; typeOnly: boolean };

export interface ParsedModule {
  file: string;
  code: string;
  program: AstNode;
  comments: Comment[];
  imports: ImportInfo[];
  /** Imported local names. */
  bindings: Map<string, Binding>;
  /** Top-level declarations by name (a name can be both an interface and a const). */
  declarations: Map<string, LocalDeclaration[]>;
  exports: Map<string, ExportEntry>;
  /** `export * from '...'` sources. */
  starExports: string[];
  /** Top-level class declarations. */
  classes: AstNode[];
  /** Parse errors, as [message, offset]. */
  errors: Array<{ message: string; offset: number }>;
  position(offset: number): { line: number; column: number };
}

function lineStarts(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function nameOf(node: AstNode): string {
  return node.type === 'Identifier' ? node.name : String(node.value);
}

/** The expression inside type assertions, `!` and parentheses. */
export const unwrap = (node: AstNode): AstNode =>
  node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'ParenthesizedExpression' || node.type === 'TSNonNullExpression'
    ? unwrap(node.expression)
    : node;

/** The static key of an object property (`a`, `'a'`, `1`, `` [`a`] ``), if it has one. */
export function staticKey(prop: AstNode): string | undefined {
  const key = prop.key as AstNode;
  if (!prop.computed && key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) return String(key.value);
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0) return key.quasis[0].value.cooked;
  return undefined;
}

/** Names bound by a destructuring pattern. */
export function patternNames(node: AstNode | null | undefined, out: AstNode[] = []): AstNode[] {
  if (!node) return out;
  switch (node.type) {
    case 'Identifier':
      out.push(node);
      break;
    case 'ObjectPattern':
      for (const p of node.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out);
      break;
    case 'ArrayPattern':
      for (const el of node.elements) patternNames(el, out);
      break;
    case 'AssignmentPattern':
      patternNames(node.left, out);
      break;
    case 'RestElement':
      patternNames(node.argument, out);
      break;
    case 'TSParameterProperty':
      patternNames(node.parameter, out);
      break;
  }
  return out;
}

function declare(map: Map<string, LocalDeclaration[]>, name: string, decl: LocalDeclaration): void {
  const list = map.get(name);
  if (list) list.push(decl);
  else map.set(name, [decl]);
}

function collectDeclaration(node: AstNode, map: Map<string, LocalDeclaration[]>, classes: AstNode[]): string[] {
  switch (node.type) {
    case 'ClassDeclaration':
      classes.push(node);
      if (node.id) declare(map, node.id.name, { kind: 'class', node, hasValue: !node.declare });
      return node.id ? [node.id.name] : [];
    case 'FunctionDeclaration':
    case 'TSDeclareFunction':
      if (node.id) declare(map, node.id.name, { kind: 'function', node, hasValue: true });
      return node.id ? [node.id.name] : [];
    case 'VariableDeclaration': {
      const names: string[] = [];
      for (const d of node.declarations) {
        for (const id of patternNames(d.id)) {
          declare(map, id.name, { kind: 'variable', node: d, hasValue: true });
          names.push(id.name);
        }
      }
      return names;
    }
    case 'TSInterfaceDeclaration':
      declare(map, node.id.name, { kind: 'interface', node, hasValue: false });
      return [node.id.name];
    case 'TSTypeAliasDeclaration':
      declare(map, node.id.name, { kind: 'type', node, hasValue: false });
      return [node.id.name];
    case 'TSEnumDeclaration':
      declare(map, node.id.name, { kind: 'enum', node, hasValue: true });
      return [node.id.name];
    case 'TSModuleDeclaration':
      if (node.id?.type === 'Identifier') {
        declare(map, node.id.name, { kind: 'namespace', node, hasValue: !node.declare });
        return [node.id.name];
      }
      return [];
    default:
      return [];
  }
}

export function parseModule(file: string, code: string): ParsedModule {
  const lang = /\.[cm]?tsx$/.test(file) ? 'tsx' : /\.[cm]?ts$/.test(file) ? 'ts' : 'js';
  const result = parseSync(file, code, { sourceType: 'module', lang });
  const program = result.program as unknown as AstNode;
  const starts = lineStarts(code);
  const position = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo]! + 1 };
  };

  const imports: ImportInfo[] = [];
  const bindings = new Map<string, Binding>();
  const declarations = new Map<string, LocalDeclaration[]>();
  const exports = new Map<string, ExportEntry>();
  const starExports: string[] = [];
  const classes: AstNode[] = [];

  for (const stmt of program.body as AstNode[]) {
    switch (stmt.type) {
      case 'ImportDeclaration': {
        const declTypeOnly = stmt.importKind === 'type';
        const specifiers: ImportSpecifierInfo[] = [];
        for (const s of stmt.specifiers as AstNode[]) {
          const typeOnly = declTypeOnly || s.importKind === 'type';
          const imported = s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? '*' : nameOf(s.imported);
          specifiers.push({ imported, local: s.local.name, typeOnly });
          bindings.set(s.local.name, { source: stmt.source.value, imported, typeOnly });
        }
        imports.push({
          source: stmt.source.value,
          node: stmt,
          form: 'import',
          typeOnly: declTypeOnly,
          inlineTypeOnly: !declTypeOnly && specifiers.length > 0 && specifiers.every((s) => s.typeOnly),
          specifiers,
        });
        break;
      }
      case 'ExportNamedDeclaration': {
        const declTypeOnly = stmt.exportKind === 'type';
        if (stmt.declaration) {
          const typeDecl = ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration'].includes(stmt.declaration.type);
          for (const name of collectDeclaration(stmt.declaration, declarations, classes)) {
            const existing = exports.get(name);
            // `export interface X` + `export const X`: the value wins.
            if (!existing || (existing.typeOnly && !typeDecl)) exports.set(name, { kind: 'local', local: name, typeOnly: typeDecl });
          }
          break;
        }
        const specifiers: ImportSpecifierInfo[] = [];
        for (const s of stmt.specifiers as AstNode[]) {
          const typeOnly = declTypeOnly || s.exportKind === 'type';
          const local = nameOf(s.local);
          const exported = nameOf(s.exported);
          specifiers.push({ imported: local, local: exported, typeOnly });
          exports.set(
            exported,
            stmt.source ? { kind: 'reexport', source: stmt.source.value, imported: local, typeOnly } : { kind: 'local', local, typeOnly },
          );
        }
        if (stmt.source) {
          imports.push({
            source: stmt.source.value,
            node: stmt,
            form: 'export',
            typeOnly: declTypeOnly,
            inlineTypeOnly: !declTypeOnly && specifiers.length > 0 && specifiers.every((s) => s.typeOnly),
            specifiers,
          });
        }
        break;
      }
      case 'ExportAllDeclaration': {
        const typeOnly = stmt.exportKind === 'type';
        if (stmt.exported) exports.set(nameOf(stmt.exported), { kind: 'reexport', source: stmt.source.value, imported: '*', typeOnly });
        else if (!typeOnly) starExports.push(stmt.source.value);
        imports.push({ source: stmt.source.value, node: stmt, form: 'export', typeOnly, inlineTypeOnly: false, specifiers: [] });
        break;
      }
      case 'ExportDefaultDeclaration': {
        const d = stmt.declaration as AstNode;
        if (d.type === 'ClassDeclaration' || d.type === 'FunctionDeclaration') {
          collectDeclaration(d, declarations, classes);
          exports.set('default', { kind: 'local', local: d.id?.name ?? '*default*', typeOnly: false });
        } else if (d.type === 'Identifier') {
          exports.set('default', { kind: 'local', local: d.name, typeOnly: false });
        } else {
          exports.set('default', { kind: 'local', local: '*default*', typeOnly: d.type === 'TSInterfaceDeclaration' });
        }
        break;
      }
      default:
        collectDeclaration(stmt, declarations, classes);
    }
  }

  // Only the specifier is re-parsed: the module record has spans, not values.
  for (const { start, end, moduleRequest } of result.module.dynamicImports) {
    const node: AstNode = { type: 'ImportExpression', start, end };
    const src = (parseSync('specifier.js', code.slice(moduleRequest.start, moduleRequest.end)).program.body[0] as AstNode | undefined)?.expression;
    const value = src?.type === 'Literal' && typeof src.value === 'string' ? src.value : src?.type === 'TemplateLiteral' && src.expressions.length === 0 ? src.quasis[0].value.cooked : undefined;
    if (value !== undefined) imports.push({ source: value, node, form: 'dynamic', typeOnly: false, inlineTypeOnly: false, specifiers: [] });
  }

  // `export { X }` of an imported or locally declared name: the export is type-only when X is.
  for (const [name, entry] of exports) {
    if (entry.kind !== 'local' || entry.typeOnly) continue;
    const binding = bindings.get(entry.local);
    if (binding) {
      exports.set(name, { kind: 'reexport', source: binding.source, imported: binding.imported, typeOnly: binding.typeOnly });
      continue;
    }
    const decls = declarations.get(entry.local);
    if (decls && !decls.some((d) => d.hasValue)) exports.set(name, { ...entry, typeOnly: true });
  }

  return {
    file,
    code,
    program,
    comments: result.comments as Comment[],
    imports,
    bindings,
    declarations,
    exports,
    starExports,
    classes,
    errors: result.errors.map((e) => ({ message: e.message, offset: e.labels?.[0]?.start ?? 0 })),
    position,
  };
}

/** The name a local value is exported under: its own name when it can, else the first alphabetically. `default` does not count. */
export function exportNameOf(mod: ParsedModule, local: string): string | undefined {
  const names: string[] = [];
  for (const [name, entry] of mod.exports) if (entry.kind === 'local' && entry.local === local && !entry.typeOnly && name !== 'default') names.push(name);
  return names.includes(local) ? local : names.sort()[0];
}
