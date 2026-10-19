import { staticKey, unwrap, type AstNode } from './source.js';

/** A reference to a class or token by name, such as an entry of `inject: [...]`. */
export class Ref {
  readonly name: string;
  readonly node: AstNode;
  constructor(name: string, node: AstNode) {
    this.name = name;
    this.node = node;
  }
}

/** A function value, such as `dedupeBy`. Recorded as present, never evaluated. */
export class Fn {
  readonly node: AstNode;
  constructor(node: AstNode) {
    this.node = node;
  }
}

export type Literal = string | number | boolean | null | Ref | Fn | Literal[] | { [key: string]: Literal };
export type LiteralObject = { [key: string]: Literal };

export class LiteralError extends Error {
  readonly node: AstNode;
  readonly hint: string;
  constructor(message: string, node: AstNode, hint: string) {
    super(message);
    this.node = node;
    this.hint = hint;
  }
}

export interface LiteralContext {
  /** The decorator, such as `@Activity`. Options are described as `@Activity option "timeout"`. */
  label: string;
  /** How to describe the whole value. Defaults to `<label> options`. */
  whole?: string;
  /** Top-level option keys whose values may reference classes or tokens by name. */
  refKeys?: ReadonlySet<string>;
  /** Top-level option keys whose values may be functions. */
  fnKeys?: ReadonlySet<string>;
  /** The whole value may be (or contain) references. */
  allowRefs?: boolean;
}

const HINT = 'norn gen reads decorators without running your code, so options must be written inline as literals';

function describe(node: AstNode): string {
  switch (node.type) {
    case 'Identifier':
      return `identifier ${node.name}`;
    case 'TemplateLiteral':
      return 'a template literal with expressions';
    case 'SpreadElement':
      return 'a spread (...)';
    case 'Literal':
      return node.regex ? 'a regular expression' : 'a bigint';
    default: {
      const words = node.type.replace(/^TS/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      return `${/^[aeiou]/.test(words) ? 'an' : 'a'} ${words}`;
    }
  }
}

const INVALID = Symbol('invalid');
let collected: LiteralError[] = [];

function fail(what: string, node: AstNode, extra?: string): typeof INVALID {
  const message =
    `${what} must be a literal (a string, number, boolean, null, or an array or object of literals); found ${describe(node)}` +
    (extra ? `. ${extra}` : '');
  const hint =
    node.type === 'Identifier' ? `${HINT}: replace ${node.name} with its value.` : `${HINT}: replace this with a literal value.`;
  collected.push(new LiteralError(message, node, hint));
  return INVALID;
}

interface State {
  refs: boolean;
  fns: boolean;
}

function evaluateNode(input: AstNode, ctx: LiteralContext, state: State, path: string, depth: number): Literal | undefined | typeof INVALID {
  const node = unwrap(input);
  const here = path ? `${ctx.label} option "${path}"` : (ctx.whole ?? `${ctx.label} options`);
  switch (node.type) {
    case 'Literal':
      if (node.regex || typeof node.value === 'bigint' || node.bigint !== undefined) return fail(here, node);
      return node.value as string | number | boolean | null;
    case 'TemplateLiteral':
      if (node.expressions.length > 0) return fail(here, node);
      return node.quasis[0].value.cooked as string;
    case 'UnaryExpression':
      if ((node.operator === '-' || node.operator === '+') && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
        return node.operator === '-' ? -node.argument.value : node.argument.value;
      }
      return fail(here, node);
    case 'Identifier':
      if (node.name === 'undefined') return undefined;
      if (state.refs) return new Ref(node.name, node);
      return fail(here, node);
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      if (state.fns) return new Fn(node);
      return fail(here, node, 'Functions are only allowed for options such as dedupeBy');
    case 'ArrayExpression': {
      const out: Literal[] = [];
      node.elements.forEach((el: AstNode | null, i: number) => {
        if (el === null) return void fail(here, node, 'Arrays must not have holes');
        if (el.type === 'SpreadElement') return void fail(here, el);
        const value = evaluateNode(el, ctx, state, path ? `${path}[${i}]` : '', depth + 1);
        if (value !== undefined && value !== INVALID) out.push(value);
      });
      return out;
    }
    case 'ObjectExpression': {
      const out: LiteralObject = {};
      for (const prop of node.properties as AstNode[]) {
        if (prop.type === 'SpreadElement') {
          fail(here, prop);
          continue;
        }
        if (prop.kind !== 'init' || prop.method) {
          fail(here, prop, 'Methods and accessors are not allowed');
          continue;
        }
        const key = staticKey(prop);
        if (key === undefined) {
          fail(`${here} key`, prop.key);
          continue;
        }
        const nextState =
          depth === 0 ? { refs: state.refs || !!ctx.refKeys?.has(key), fns: state.fns || !!ctx.fnKeys?.has(key) } : state;
        const value = evaluateNode(prop.value, ctx, nextState, path ? `${path}.${key}` : key, depth + 1);
        if (value !== undefined && value !== INVALID) out[key] = value;
      }
      return out;
    }
    default:
      return fail(here, node);
  }
}

/** Evaluates a decorator argument that must be a literal, listing every problem in `errors`. */
export function evaluateLiteral(node: AstNode, ctx: LiteralContext): { value: Literal | undefined; errors: LiteralError[] } {
  collected = [];
  const value = evaluateNode(node, ctx, { refs: !!ctx.allowRefs, fns: false }, '', 0);
  const errors = collected;
  collected = [];
  return { value: value === INVALID ? undefined : value, errors };
}

export function isObject(value: Literal | undefined): value is LiteralObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Ref) && !(value instanceof Fn);
}
