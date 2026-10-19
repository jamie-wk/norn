import type { NornGenError, NornGenErrorCode } from './errors.js';
import { Fn, LiteralErrors, Ref, evaluateLiteral, isObject, type Literal, type LiteralContext, type LiteralObject } from './literal.js';
import { isRelative, type Project } from './project.js';
import { exportNamesOf, type AstNode, type ParsedModule } from './source.js';

export interface Location {
  file: string;
  line: number;
  column: number;
}

export type SearchAttributeType = 'text' | 'keyword' | 'int' | 'double' | 'bool' | 'datetime' | 'keywordList';
export const SEARCH_ATTRIBUTE_TYPES: readonly SearchAttributeType[] = ['text', 'keyword', 'int', 'double', 'bool', 'datetime', 'keywordList'];
export type ScheduleOverlap = 'skip' | 'buffer-one' | 'buffer-all' | 'cancel-other' | 'terminate-other' | 'allow-all';
export const OVERLAPS: readonly ScheduleOverlap[] = ['skip', 'buffer-one', 'buffer-all', 'cancel-other', 'terminate-other', 'allow-all'];

export interface HandlerModel {
  /** Method that implements the handler. */
  method: string;
  /** Registered Temporal name. */
  name: string;
}

export interface ScheduleModel {
  id: string;
  workflowType: string;
  taskQueue: string;
  cron: string[];
  input?: Literal;
  overlap?: ScheduleOverlap;
  timeZone?: string;
  pauseOnFailure?: boolean;
  paused?: boolean;
  note?: string;
  loc: Location;
}

export interface WorkflowModel {
  className: string;
  /** Name the class is exported under from its module. */
  exportName: string;
  /** Temporal workflow type name. */
  name: string;
  file: string;
  taskQueue: string;
  id?: string;
  searchAttributes: Record<string, SearchAttributeType>;
  signals: HandlerModel[];
  queries: HandlerModel[];
  updates: HandlerModel[];
  /** JSDoc of handler methods without an explicit `description`, keyed by method. */
  descriptions: Record<string, string>;
  schedules: ScheduleModel[];
  loc: Location;
  searchAttributeLocs: Record<string, Location>;
}

/** A dependency key: a value exported by a module. */
export interface DependencyRef {
  /** Absolute file path, or a bare package specifier. */
  module: { kind: 'file'; path: string } | { kind: 'package'; specifier: string };
  name: string;
}

export interface ActivityMethodModel {
  method: string;
  /** Registered name, including the class prefix. */
  name: string;
  /** `@Activity` options as written, with `nonRetryable` filled in from `@NonRetryable([...])`. */
  options: LiteralObject;
  loc: Location;
}

export interface ActivitiesModel {
  className: string;
  exportName: string;
  file: string;
  prefix: string;
  methods: ActivityMethodModel[];
  deps: DependencyRef[];
  loc: Location;
}

export interface ServiceModel {
  className: string;
  exportName: string;
  file: string;
  deps: DependencyRef[];
  loc: Location;
}

export interface Analysis {
  workflows: WorkflowModel[];
  activities: ActivitiesModel[];
  services: ServiceModel[];
  /** Files that declare @Workflow classes. */
  workflowFiles: string[];
  errors: NornGenError[];
}

const PACKAGES: Record<string, ReadonlySet<string>> = {
  '@norn/workflow': new Set(['Workflow', 'Signal', 'Query', 'Update', 'Validate', 'Schedule']),
  '@norn/activity': new Set(['Activities', 'Activity', 'NonRetryable', 'Service']),
};
const HANDLER_KINDS = { Signal: 'signal', Query: 'query', Update: 'update' } as const;
type HandlerKind = (typeof HANDLER_KINDS)[keyof typeof HANDLER_KINDS];
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const WORKFLOW_KEYS = new Set(['taskQueue', 'name', 'id', 'versioning', 'searchAttributes', 'failOn', 'drainHandlers', 'description']);
const SIGNAL_KEYS = new Set(['name', 'description', 'unfinishedPolicy', 'dedupeBy']);
const QUERY_KEYS = new Set(['name', 'description']);
const UPDATE_KEYS = new Set(['name', 'description', 'unfinishedPolicy']);
const ACTIVITY_KEYS = new Set([
  'name',
  'timeout',
  'scheduleToClose',
  'scheduleToStart',
  'heartbeat',
  'retries',
  'retry',
  'local',
  'nonRetryable',
  'taskQueue',
  'summary',
]);
const RETRY_KEYS = new Set(['initialInterval', 'backoffCoefficient', 'maximumInterval', 'maximumAttempts']);
const ACTIVITIES_KEYS = new Set(['prefix', 'inject']);
const SERVICE_KEYS = new Set(['provides', 'scope', 'inject']);
const SCHEDULE_KEYS = new Set(['id', 'input', 'overlap', 'timeZone', 'pauseOnFailure', 'paused', 'note']);

/** A recognized Norn decorator. */
interface Decorator {
  name: string;
  /** The `@...` node. */
  node: AstNode;
  called: boolean;
  args: AstNode[];
}

interface Member {
  mod: ParsedModule;
  node: AstNode;
  key: string | undefined;
  decorators: Decorator[];
}

interface ClassInfo {
  mod: ParsedModule;
  node: AstNode;
  name: string;
  decorators: Decorator[];
  members: Member[];
}

/** `OrderWorkflow` → `order-workflow`. */
export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

function decoratorOf(mod: ParsedModule, decorator: AstNode): Decorator | undefined {
  const expr = decorator.expression as AstNode;
  const called = expr.type === 'CallExpression';
  const callee = (called ? expr.callee : expr) as AstNode;
  const args = called ? (expr.arguments as AstNode[]) : [];
  if (callee.type === 'Identifier') {
    const binding = mod.bindings.get(callee.name);
    if (!binding || binding.typeOnly) return undefined;
    if (PACKAGES[binding.source]?.has(binding.imported)) return { name: binding.imported, node: decorator, called, args };
    return undefined;
  }
  if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier') {
    const binding = mod.bindings.get(callee.object.name);
    if (binding?.imported === '*' && !binding.typeOnly && PACKAGES[binding.source]?.has(callee.property.name)) {
      return { name: callee.property.name, node: decorator, called, args };
    }
  }
  return undefined;
}

function memberKey(node: AstNode): string | undefined {
  if (node.computed) return node.key.type === 'Literal' && typeof node.key.value === 'string' ? node.key.value : undefined;
  if (node.key.type === 'Identifier') return node.key.name;
  if (node.key.type === 'PrivateIdentifier') return `#${node.key.name}`;
  if (node.key.type === 'Literal') return String(node.key.value);
  return undefined;
}

function classInfo(mod: ParsedModule, node: AstNode): ClassInfo {
  const decorators = (node.decorators as AstNode[]).map((d) => decoratorOf(mod, d)).filter((d): d is Decorator => !!d);
  const members: Member[] = [];
  for (const m of node.body.body as AstNode[]) {
    if (!('key' in m)) continue;
    members.push({
      mod,
      node: m,
      key: memberKey(m),
      decorators: ((m.decorators ?? []) as AstNode[]).map((d) => decoratorOf(mod, d)).filter((d): d is Decorator => !!d),
    });
  }
  return { mod, node, name: node.id?.name ?? 'default', decorators, members };
}

/** True when the module declares an @Activities or @Service class. */
export function declaresActivityCode(mod: ParsedModule): boolean {
  return mod.classes.some((c) =>
    (c.decorators as AstNode[]).some((d) => {
      const name = decoratorOf(mod, d)?.name;
      return name === 'Activities' || name === 'Service';
    }),
  );
}

export function declaresWorkflow(mod: ParsedModule): boolean {
  return mod.classes.some((c) => (c.decorators as AstNode[]).some((d) => decoratorOf(mod, d)?.name === 'Workflow'));
}

function jsDoc(mod: ParsedModule, node: AstNode): string | undefined {
  let best: { value: string; end: number } | undefined;
  for (const c of mod.comments) {
    if (c.end > node.start) break;
    if (c.type === 'Block' && c.value.startsWith('*')) best = c;
  }
  if (!best || mod.code.slice(best.end, node.start).trim() !== '') return undefined;
  const lines = best.value
    .slice(1)
    .split('\n')
    .map((l) => l.replace(/^\s*\*?\s?/, '').trimEnd());
  const text: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith('@')) break;
    text.push(line);
  }
  const joined = text.join(' ').replace(/\s+/g, ' ').trim();
  return joined || undefined;
}

export class Analyzer {
  readonly errors: NornGenError[] = [];
  private readonly project: Project;

  constructor(project: Project) {
    this.project = project;
  }

  loc(mod: ParsedModule, node: AstNode | number): Location {
    const offset = typeof node === 'number' ? node : node.start;
    return { file: this.project.rel(mod.file), ...mod.position(offset) };
  }

  error(code: NornGenErrorCode, mod: ParsedModule, node: AstNode | number, message: string, hint?: string): void {
    this.errors.push({ code, message, ...this.loc(mod, node), ...(hint ? { hint } : {}) });
  }

  private where(loc: Location): string {
    return `${loc.file}:${loc.line}`;
  }

  /** Evaluates a literal, reporting a `non-literal` error and returning `null` (not `undefined`) on failure. */
  private literal(mod: ParsedModule, node: AstNode, ctx: LiteralContext): Literal | undefined | typeof FAILED {
    try {
      return evaluateLiteral(node, ctx);
    } catch (error) {
      if (!(error instanceof LiteralErrors)) throw error;
      for (const e of error.errors) this.error('non-literal', mod, e.node, e.message, e.hint);
      return FAILED;
    }
  }

  /** Evaluates an optional options-object argument. */
  private options(mod: ParsedModule, dec: Decorator, index: number, ctx: Omit<LiteralContext, 'label'>, known: ReadonlySet<string>): LiteralObject | typeof FAILED {
    const node = dec.args[index];
    if (!node) return {};
    const label = `@${dec.name}`;
    const value = this.literal(mod, node, { label, ...ctx });
    if (value === FAILED) return FAILED;
    if (value === undefined) return {};
    if (!isObject(value)) {
      this.error('invalid-option', mod, node, `${label} options must be an object`);
      return FAILED;
    }
    let ok = true;
    for (const key of Object.keys(value)) {
      if (!known.has(key)) {
        this.error('invalid-option', mod, propertyNode(node, key) ?? node, `${label} has no option "${key}"`, `Known options: ${[...known].join(', ')}`);
        ok = false;
      }
    }
    return ok ? value : FAILED;
  }

  private checkCalled(mod: ParsedModule, dec: Decorator): boolean {
    if (dec.called) return true;
    this.error('invalid-decorator', mod, dec.node, `@${dec.name} must be called: write @${dec.name}()`);
    return false;
  }

  /** Base classes first, then the class itself. Bases that cannot be resolved syntactically are skipped. */
  private chain(info: ClassInfo, depth = 0): ClassInfo[] {
    const sup = info.node.superClass as AstNode | null;
    if (!sup || sup.type !== 'Identifier' || depth > 16) return [info];
    const base = this.findClass(info.mod, sup.name);
    return base ? [...this.chain(base, depth + 1), info] : [info];
  }

  private findClass(mod: ParsedModule, name: string): ClassInfo | undefined {
    const local = mod.declarations.get(name)?.find((d) => d.kind === 'class');
    if (local) return classInfo(mod, local.node);
    const binding = mod.bindings.get(name);
    if (!binding || !isRelative(binding.source)) return undefined;
    const target = this.project.resolve(mod.file, binding.source);
    if (!target) return undefined;
    const found = this.project.findExport(target, binding.imported);
    if (!found) return undefined;
    const targetMod = this.project.module(found.file);
    const decl = targetMod.declarations.get(found.local)?.find((d) => d.kind === 'class');
    return decl ? classInfo(targetMod, decl.node) : undefined;
  }

  /** Reports decorators on members they cannot decorate. Returns false for invalid members. */
  private checkMember(member: Member, dec: Decorator): boolean {
    const { node, mod } = member;
    const label = `@${dec.name}`;
    if (node.key?.type === 'PrivateIdentifier') {
      this.error('invalid-member', mod, dec.node, `${label} cannot decorate private member ${member.key}`, 'Make it a public method.');
      return false;
    }
    if (node.static) {
      this.error('invalid-member', mod, dec.node, `${label} cannot decorate static method ${member.key}()`, 'Make it an instance method.');
      return false;
    }
    if (node.type !== 'MethodDefinition' || node.kind !== 'method') {
      this.error('invalid-member', mod, dec.node, `${label} can only decorate methods`);
      return false;
    }
    if (member.key === undefined) {
      this.error('invalid-member', mod, dec.node, `${label} cannot decorate computed or symbol-named methods`);
      return false;
    }
    return this.checkCalled(mod, dec);
  }

  private exportName(info: ClassInfo, kind: string): string | undefined {
    const names = exportNamesOf(info.mod, info.name).filter((n) => n !== 'default');
    if (names.length > 0) return names.includes(info.name) ? info.name : names.toSorted()[0];
    this.error(
      'not-exported',
      info.mod,
      info.node.id ?? info.node,
      `${kind} class ${info.name} must be a named export: generated files import it by name`,
      `Write export class ${info.name} { ... }`,
    );
    return undefined;
  }

  analyze(files: string[]): Omit<Analysis, 'errors'> {
    const workflows: WorkflowModel[] = [];
    const activities: ActivitiesModel[] = [];
    const services: ServiceModel[] = [];
    const workflowFiles = new Set<string>();

    for (const file of files) {
      const mod = this.project.module(file);
      for (const e of mod.errors) this.error('parse-error', mod, e.offset, e.message);
      if (mod.errors.length > 0) continue;
      for (const node of mod.classes) {
        const info = classInfo(mod, node);
        const kinds = info.decorators.filter((d) => d.name === 'Workflow' || d.name === 'Activities' || d.name === 'Service');
        const schedules = info.decorators.filter((d) => d.name === 'Schedule');
        const misplaced = info.decorators.filter((d) => d.name === 'Signal' || d.name === 'Query' || d.name === 'Update' || d.name === 'Validate' || d.name === 'Activity');
        for (const d of misplaced) this.error('invalid-decorator', mod, d.node, `@${d.name} decorates methods, not classes`);
        const distinct = [...new Set(kinds.map((d) => d.name))];
        if (distinct.length > 1) {
          this.error(
            'invalid-decorator',
            mod,
            node.id ?? node,
            `${info.name} cannot be both ${distinct.map((n) => `@${n}`).join(' and ')}`,
            'Workflows, activity classes and services must be separate classes.',
          );
          continue;
        }
        if (kinds.length > 1) {
          this.error('invalid-decorator', mod, kinds[1]!.node, `${info.name} is decorated with @${kinds[1]!.name} more than once`);
          continue;
        }
        const kind = kinds[0];
        if (kind?.name === 'Workflow') workflowFiles.add(file);
        if (!kind) {
          for (const s of schedules) {
            this.error('invalid-decorator', mod, s.node, `@Schedule needs a @Workflow class: ${info.name} is not decorated with @Workflow`);
          }
          // Member decorators in undecorated classes are fine: they may be base classes.
          continue;
        }
        if (!this.checkCalled(mod, kind)) continue;
        if (kind.name === 'Workflow') {
          const wf = this.workflow(info, kind, schedules);
          if (wf) workflows.push(wf);
        } else if (kind.name === 'Activities') {
          for (const s of schedules) this.error('invalid-decorator', mod, s.node, '@Schedule needs a @Workflow class');
          const act = this.activitiesClass(info, kind);
          if (act) activities.push(act);
        } else {
          for (const s of schedules) this.error('invalid-decorator', mod, s.node, '@Schedule needs a @Workflow class');
          const svc = this.service(info, kind);
          if (svc) services.push(svc);
        }
      }
    }

    this.checkDuplicates(workflows, activities);
    return { workflows, activities, services, workflowFiles: [...workflowFiles] };
  }

  private workflow(info: ClassInfo, dec: Decorator, scheduleDecs: Decorator[]): WorkflowModel | undefined {
    const { mod } = info;
    let ok = true;
    const optionsNode = dec.args[0];
    const options = this.options(mod, dec, 0, { refKeys: new Set(['failOn']) }, WORKFLOW_KEYS);
    if (options === FAILED) ok = false;
    const o = options === FAILED ? {} : options;
    const prop = (key: string) => (optionsNode && propertyNode(optionsNode, key)) ?? optionsNode ?? dec.node;
    const invalid = (key: string, message: string, hint?: string) => {
      this.error('invalid-option', mod, prop(key), `@Workflow on ${info.name}: ${message}`, hint);
      ok = false;
    };

    if (options !== FAILED) {
      if (!optionsNode) invalid('taskQueue', 'options with a taskQueue are required');
      else if (typeof o.taskQueue !== 'string' || o.taskQueue.trim() === '') invalid('taskQueue', 'taskQueue must be a non-empty string');
      if (o.name !== undefined && (typeof o.name !== 'string' || !IDENTIFIER.test(o.name))) {
        invalid('name', `workflow name ${JSON.stringify(o.name)} must be a valid identifier: it is the workflow's export name in the bundle`);
      }
      if (o.id !== undefined && typeof o.id !== 'string') invalid('id', 'id must be an ID template string, such as "order-{orderId}"');
      if (o.versioning !== undefined && o.versioning !== 'pinned' && o.versioning !== 'auto-upgrade') {
        invalid('versioning', "versioning must be 'pinned' or 'auto-upgrade'");
      }
      if (o.drainHandlers !== undefined && typeof o.drainHandlers !== 'boolean') invalid('drainHandlers', 'drainHandlers must be a boolean');
      if (o.description !== undefined && typeof o.description !== 'string') invalid('description', 'description must be a string');
      if (o.failOn !== undefined && (!Array.isArray(o.failOn) || o.failOn.some((e) => !(e instanceof Ref)))) {
        invalid('failOn', 'failOn must list error classes, such as [InvalidOrderError]');
      }
      if (o.searchAttributes !== undefined) {
        if (!isObject(o.searchAttributes)) invalid('searchAttributes', 'searchAttributes must map names to types');
        else {
          const saNode = optionsNode && propertyNode(optionsNode, 'searchAttributes')?.value;
          for (const [key, type] of Object.entries(o.searchAttributes)) {
            if (!SEARCH_ATTRIBUTE_TYPES.includes(type as SearchAttributeType)) {
              this.error(
                'invalid-option',
                mod,
                (saNode && propertyNode(saNode, key)) ?? prop('searchAttributes'),
                `@Workflow on ${info.name}: search attribute ${key} has unknown type ${JSON.stringify(type)}; use one of ${SEARCH_ATTRIBUTE_TYPES.join(', ')}`,
              );
              ok = false;
            }
          }
        }
      }
    }

    const exportName = this.exportName(info, 'Workflow');
    if (!exportName) ok = false;
    const name = typeof o.name === 'string' ? o.name : info.name;
    const taskQueue = typeof o.taskQueue === 'string' ? o.taskQueue : '';

    // Handlers, through the inheritance chain. Overrides keep the inherited registration.
    const handlers = new Map<string, { kind: HandlerKind; name: string; dec: Decorator; member: Member; description?: string }>();
    const validators: Array<{ update: string; dec: Decorator; member: Member }> = [];
    let hasRun = false;
    for (const cls of this.chain(info)) {
      for (const member of cls.members) {
        if (member.key === 'run' && member.node.type === 'MethodDefinition' && member.node.kind === 'method' && !member.node.static) hasRun = true;
        for (const d of member.decorators) {
          if (d.name === 'Activity' || d.name === 'NonRetryable') {
            this.error('invalid-decorator', member.mod, d.node, `@${d.name} can only be used in an @Activities class`);
            ok = false;
            continue;
          }
          if (d.name === 'Workflow' || d.name === 'Schedule' || d.name === 'Activities' || d.name === 'Service') {
            this.error('invalid-decorator', member.mod, d.node, `@${d.name} decorates classes, not members`);
            ok = false;
            continue;
          }
          if (!this.checkMember(member, d)) {
            ok = false;
            continue;
          }
          const method = member.key!;
          if (d.name === 'Validate') {
            const arg = d.args[0];
            const update = arg ? this.literal(member.mod, arg, { label: '@Validate', whole: '@Validate update name' }) : undefined;
            if (update === FAILED) {
              ok = false;
              continue;
            }
            if (typeof update !== 'string' || update === '') {
              this.error('invalid-decorator', member.mod, d.node, "@Validate needs the update method's name, such as @Validate('addItem')");
              ok = false;
              continue;
            }
            validators.push({ update, dec: d, member });
            continue;
          }
          const kind = HANDLER_KINDS[d.name as keyof typeof HANDLER_KINDS];
          const keys = kind === 'signal' ? SIGNAL_KEYS : kind === 'query' ? QUERY_KEYS : UPDATE_KEYS;
          let handlerOptions: LiteralObject = {};
          const arg = d.args[0];
          if (arg) {
            const value = this.literal(member.mod, arg, { label: `@${d.name}`, fnKeys: new Set(['dedupeBy']) });
            if (value === FAILED) {
              ok = false;
              continue;
            }
            if (typeof value === 'string') handlerOptions = { name: value };
            else if (isObject(value)) {
              handlerOptions = value;
              for (const key of Object.keys(value)) {
                if (!keys.has(key)) {
                  this.error('invalid-option', member.mod, propertyNode(arg, key) ?? arg, `@${d.name} has no option "${key}"`, `Known options: ${[...keys].join(', ')}`);
                  ok = false;
                }
              }
            } else if (value !== undefined) {
              this.error('invalid-option', member.mod, arg, `@${d.name} takes a name or an options object`);
              ok = false;
              continue;
            }
          }
          const hName = handlerOptions.name ?? method;
          if (typeof hName !== 'string' || hName === '') {
            this.error('invalid-option', member.mod, propertyNode(arg!, 'name') ?? arg!, `@${d.name} name must be a non-empty string`);
            ok = false;
            continue;
          }
          const policy = handlerOptions.unfinishedPolicy;
          if (policy !== undefined && policy !== 'abandon' && policy !== 'warn') {
            this.error('invalid-option', member.mod, propertyNode(arg!, 'unfinishedPolicy') ?? arg!, "unfinishedPolicy must be 'abandon' or 'warn'");
            ok = false;
          }
          if (handlerOptions.dedupeBy !== undefined && !(handlerOptions.dedupeBy instanceof Fn)) {
            this.error('invalid-option', member.mod, propertyNode(arg!, 'dedupeBy') ?? arg!, 'dedupeBy must be a function');
            ok = false;
          }
          // Explicit descriptions travel with the decorator at runtime; JSDoc ones go into implement().
          const doc = handlerOptions.description === undefined ? jsDoc(member.mod, member.node) : undefined;
          handlers.set(method, { kind, name: hName, dec: d, member, ...(doc ? { description: doc } : {}) });
        }
      }
    }

    // Duplicate registered names, per kind, in declaration order.
    const seen = { signal: new Map<string, string>(), query: new Map<string, string>(), update: new Map<string, string>() };
    for (const [method, h] of handlers) {
      const first = seen[h.kind].get(h.name);
      if (first) {
        this.error(
          'duplicate-handler',
          h.member.mod,
          h.dec.node,
          `Workflow ${name}: ${h.kind} "${h.name}" is registered by both ${first}() and ${method}()`,
          `Give one of them a different name with @${h.dec.name}({ name: '...' })`,
        );
        ok = false;
      } else seen[h.kind].set(h.name, method);
    }

    const validated = new Set<string>();
    for (const v of validators) {
      const target = handlers.get(v.update);
      if (!target || target.kind !== 'update') {
        const message = target
          ? `@Validate('${v.update}') on ${v.member.key}(): ${v.update}() is a @${target.dec.name}, not an @Update`
          : `@Validate('${v.update}') on ${v.member.key}(): there is no @Update method ${v.update}() in ${info.name}`;
        this.error('invalid-validate', v.member.mod, v.dec.node, message, '@Validate takes the method name of an @Update handler.');
        ok = false;
      } else if (validated.has(v.update)) {
        this.error('invalid-validate', v.member.mod, v.dec.node, `Update ${v.update}() of ${info.name} has more than one validator`);
        ok = false;
      } else validated.add(v.update);
    }

    if (!hasRun) {
      this.error('missing-run', mod, info.node.id ?? info.node, `Workflow class ${info.name} needs an async run() method`, 'Add async run(input) { ... }');
      ok = false;
    }

    const schedules: ScheduleModel[] = [];
    for (const s of scheduleDecs.toSorted((a, b) => a.node.start - b.node.start)) {
      const sched = this.schedule(mod, s, name, taskQueue, info.name);
      if (sched) schedules.push(sched);
      else ok = false;
    }

    // Models with errors still take part in the cross-class checks; nothing is emitted while errors exist.
    void ok;
    if (!exportName) return undefined;
    const pick = (kind: HandlerKind) =>
      [...handlers]
        .filter(([, h]) => h.kind === kind)
        .map(([method, h]) => ({ method, name: h.name }))
        .sort((a, b) => compare(a.method, b.method));
    const descriptions: Record<string, string> = {};
    for (const [method, h] of [...handlers].sort(([a], [b]) => compare(a, b))) if (h.description) descriptions[method] = h.description;
    const searchAttributes = isObject(o.searchAttributes) ? (o.searchAttributes as Record<string, SearchAttributeType>) : {};
    const saNode = optionsNode && propertyNode(optionsNode, 'searchAttributes')?.value;
    const searchAttributeLocs: Record<string, Location> = {};
    for (const key of Object.keys(searchAttributes)) searchAttributeLocs[key] = this.loc(mod, (saNode && propertyNode(saNode, key)) ?? dec.node);
    return {
      className: info.name,
      exportName,
      name,
      file: mod.file,
      taskQueue,
      ...(typeof o.id === 'string' ? { id: o.id } : {}),
      searchAttributes,
      signals: pick('signal'),
      queries: pick('query'),
      updates: pick('update'),
      descriptions,
      schedules,
      loc: this.loc(mod, dec.node),
      searchAttributeLocs,
    };
  }

  private schedule(mod: ParsedModule, dec: Decorator, workflowType: string, taskQueue: string, className: string): ScheduleModel | undefined {
    if (!this.checkCalled(mod, dec)) return undefined;
    const cronNode = dec.args[0];
    if (!cronNode) {
      this.error('invalid-decorator', mod, dec.node, '@Schedule needs a cron expression, such as @Schedule(\'0 2 * * *\')');
      return undefined;
    }
    let ok = true;
    const cron = this.literal(mod, cronNode, { label: '@Schedule', whole: '@Schedule cron expression' });
    if (cron === FAILED) ok = false;
    const expressions = typeof cron === 'string' ? [cron] : Array.isArray(cron) ? cron : undefined;
    if (cron !== FAILED) {
      const bad = expressions === undefined || expressions.length === 0 ? cron : expressions.find((c) => typeof c !== 'string' || c.trim().split(/\s+/).length < 5);
      if (expressions === undefined || expressions.length === 0 || bad !== undefined) {
        this.error(
          'invalid-option',
          mod,
          cronNode,
          `@Schedule on ${className}: ${JSON.stringify(bad ?? cron)} is not a cron expression`,
          "Use a cron string with at least five fields, such as '0 2 * * *', or an array of them.",
        );
        ok = false;
      }
    }
    const optionsNode = dec.args[1];
    const options = this.options(mod, dec, 1, {}, SCHEDULE_KEYS);
    if (options === FAILED) return undefined;
    const prop = (key: string) => (optionsNode && propertyNode(optionsNode, key)) ?? optionsNode ?? dec.node;
    const check = (key: string, valid: boolean, message: string) => {
      if (options[key] !== undefined && !valid) {
        this.error('invalid-option', mod, prop(key), `@Schedule on ${className}: ${message}`);
        ok = false;
      }
    };
    check('id', typeof options.id === 'string' && options.id !== '', 'id must be a non-empty string');
    check('overlap', OVERLAPS.includes(options.overlap as ScheduleOverlap), `overlap must be one of ${OVERLAPS.join(', ')}`);
    check('timeZone', typeof options.timeZone === 'string', 'timeZone must be a string such as "America/New_York"');
    check('pauseOnFailure', typeof options.pauseOnFailure === 'boolean', 'pauseOnFailure must be a boolean');
    check('paused', typeof options.paused === 'boolean', 'paused must be a boolean');
    check('note', typeof options.note === 'string', 'note must be a string');
    if (!ok) return undefined;
    const spec: ScheduleModel = {
      id: typeof options.id === 'string' ? options.id : kebabCase(workflowType),
      workflowType,
      taskQueue,
      cron: expressions as string[],
      loc: this.loc(mod, dec.node),
    };
    if (options.input !== undefined) spec.input = options.input;
    for (const key of ['overlap', 'timeZone', 'pauseOnFailure', 'paused', 'note'] as const) {
      if (options[key] !== undefined) (spec as unknown as Record<string, Literal>)[key] = options[key];
    }
    return spec;
  }

  private nonRetryable(mod: ParsedModule, dec: Decorator): string[] | true | typeof FAILED {
    if (!this.checkCalled(mod, dec)) return FAILED;
    const arg = dec.args[0];
    if (!arg) return true;
    const value = this.literal(mod, arg, { label: '@NonRetryable', whole: '@NonRetryable error list', allowRefs: true });
    if (value === FAILED) return FAILED;
    if (value === undefined) return true;
    if (!Array.isArray(value) || value.some((v) => !(v instanceof Ref))) {
      this.error('invalid-option', mod, arg, '@NonRetryable takes a list of error classes, such as [InvalidCardError]');
      return FAILED;
    }
    return (value as Ref[]).map((ref) => {
      const binding = mod.bindings.get(ref.name);
      return binding && binding.imported !== 'default' && binding.imported !== '*' ? binding.imported : ref.name;
    });
  }

  private activitiesClass(info: ClassInfo, dec: Decorator): ActivitiesModel | undefined {
    const { mod } = info;
    let ok = true;
    const optionsNode = dec.args[0];
    const options = this.options(mod, dec, 0, { refKeys: new Set(['inject']) }, ACTIVITIES_KEYS);
    if (options === FAILED) ok = false;
    const o = options === FAILED ? {} : options;
    if (o.prefix !== undefined && typeof o.prefix !== 'string') {
      this.error('invalid-option', mod, (optionsNode && propertyNode(optionsNode, 'prefix')) ?? dec.node, `@Activities on ${info.name}: prefix must be a string`);
      ok = false;
    }
    const prefix = typeof o.prefix === 'string' ? o.prefix : '';

    let classNonRetryable: string[] | true | undefined;
    for (const d of info.decorators.filter((x) => x.name === 'NonRetryable')) {
      const value = this.nonRetryable(mod, d);
      if (value === FAILED) ok = false;
      else classNonRetryable = value;
    }

    const methods = new Map<string, ActivityMethodModel>();
    for (const cls of this.chain(info)) {
      for (const member of cls.members) {
        const activityDec = member.decorators.find((d) => d.name === 'Activity');
        let methodNonRetryable: string[] | true | undefined;
        for (const d of member.decorators) {
          if (d.name !== 'Activity' && d.name !== 'NonRetryable') {
            const where = d.name === 'Activities' || d.name === 'Service' || d.name === 'Workflow' || d.name === 'Schedule' ? 'decorates classes, not members' : 'can only be used in a @Workflow class';
            this.error('invalid-decorator', member.mod, d.node, `@${d.name} ${where}`);
            ok = false;
            continue;
          }
          if (!this.checkMember(member, d)) {
            ok = false;
            continue;
          }
          if (d.name === 'NonRetryable') {
            const value = this.nonRetryable(member.mod, d);
            if (value === FAILED) ok = false;
            else methodNonRetryable = value;
          }
        }
        if (!activityDec || member.key === undefined || member.key.startsWith('#') || member.node.static || member.node.type !== 'MethodDefinition') continue;
        const actOptions = this.options(member.mod, activityDec, 0, {}, ACTIVITY_KEYS);
        if (actOptions === FAILED) {
          ok = false;
          continue;
        }
        if (!this.validateActivityOptions(member.mod, activityDec, actOptions)) ok = false;
        const tag = methodNonRetryable ?? classNonRetryable;
        const recorded: LiteralObject = { ...actOptions };
        if (Array.isArray(tag)) recorded.nonRetryable = tag;
        const activityName = `${prefix}${typeof actOptions.name === 'string' ? actOptions.name : member.key}`;
        methods.set(member.key, { method: member.key, name: activityName, options: recorded, loc: this.loc(member.mod, activityDec.node) });
      }
    }

    const names = new Map<string, string>();
    for (const m of methods.values()) {
      const first = names.get(m.name);
      if (first) {
        this.errors.push({
          code: 'duplicate-activity',
          message: `Activity "${m.name}" is used by more than one method of ${info.name}: ${first}() and ${m.method}()`,
          ...m.loc,
          hint: "Give one of them a different name with @Activity({ name: '...' })",
        });
        ok = false;
      } else names.set(m.name, m.method);
    }
    if (methods.size === 0 && !this.chain(info).some((c) => c.members.some((m) => m.decorators.some((d) => d.name === 'Activity')))) {
      this.error('invalid-decorator', mod, info.node.id ?? info.node, `@Activities class ${info.name} has no @Activity methods`, 'Decorate the methods to register with @Activity().');
      ok = false;
    }

    const deps = this.dependencies(info, o.inject, optionsNode, 'Activities');
    const exportName = this.exportName(info, '@Activities');
    void ok;
    if (!exportName) return undefined;
    return {
      className: info.name,
      exportName,
      file: mod.file,
      prefix,
      methods: [...methods.values()].sort((a, b) => compare(a.method, b.method)),
      deps: deps ?? [],
      loc: this.loc(mod, info.node.id ?? info.node),
    };
  }

  private validateActivityOptions(mod: ParsedModule, dec: Decorator, o: LiteralObject): boolean {
    let ok = true;
    const node = dec.args[0];
    const fail = (key: string, message: string) => {
      this.error('invalid-option', mod, (node && propertyNode(node, key)) ?? dec.node, `@Activity option "${key}" ${message}`);
      ok = false;
    };
    const duration = (v: Literal) => (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && v >= 0);
    if (o.name !== undefined && (typeof o.name !== 'string' || o.name === '')) fail('name', 'must be a non-empty string');
    for (const key of ['timeout', 'scheduleToClose', 'scheduleToStart', 'heartbeat']) {
      if (o[key] !== undefined && !duration(o[key])) fail(key, "must be a duration such as '30s' or a number of milliseconds");
    }
    if (o.retries !== undefined && !(typeof o.retries === 'number' && Number.isInteger(o.retries) && o.retries >= 0)) fail('retries', 'must be a non-negative integer');
    if (o.local !== undefined && typeof o.local !== 'boolean') fail('local', 'must be a boolean');
    if (o.taskQueue !== undefined && typeof o.taskQueue !== 'string') fail('taskQueue', 'must be a string');
    if (o.summary !== undefined && typeof o.summary !== 'string') fail('summary', 'must be a string');
    if (o.nonRetryable !== undefined && !(Array.isArray(o.nonRetryable) && o.nonRetryable.every((v) => typeof v === 'string'))) {
      fail('nonRetryable', 'must be a list of error type names');
    }
    if (o.retry !== undefined) {
      if (!isObject(o.retry)) fail('retry', 'must be an object');
      else {
        for (const key of Object.keys(o.retry)) if (!RETRY_KEYS.has(key)) fail('retry', `has no field "${key}"; use ${[...RETRY_KEYS].join(', ')}`);
        if (o.retries !== undefined && o.retry.maximumAttempts !== undefined) fail('retries', 'cannot be combined with retry.maximumAttempts');
      }
    }
    return ok;
  }

  private service(info: ClassInfo, dec: Decorator): ServiceModel | undefined {
    const { mod } = info;
    let ok = true;
    const optionsNode = dec.args[0];
    const options = this.options(mod, dec, 0, { refKeys: new Set(['inject', 'provides']) }, SERVICE_KEYS);
    if (options === FAILED) ok = false;
    const o = options === FAILED ? {} : options;
    if (o.scope !== undefined && o.scope !== 'singleton' && o.scope !== 'activity') {
      this.error('invalid-option', mod, (optionsNode && propertyNode(optionsNode, 'scope')) ?? dec.node, `@Service on ${info.name}: scope must be 'singleton' or 'activity'`);
      ok = false;
    }
    if (o.provides !== undefined && !(o.provides instanceof Ref)) {
      this.error('invalid-option', mod, (optionsNode && propertyNode(optionsNode, 'provides')) ?? dec.node, `@Service on ${info.name}: provides must be a class or token`);
      ok = false;
    }
    for (const member of info.members) {
      for (const d of member.decorators) {
        this.error('invalid-decorator', mod, d.node, `@${d.name} cannot be used in a @Service class`);
        ok = false;
      }
    }
    const deps = this.dependencies(info, o.inject, optionsNode, 'Service');
    const exportName = this.exportName(info, '@Service');
    void ok;
    if (!exportName) return undefined;
    return { className: info.name, exportName, file: mod.file, deps: deps ?? [], loc: this.loc(mod, info.node.id ?? info.node) };
  }

  /** Constructor dependencies: `inject` when given, otherwise inferred from parameter types. */
  private dependencies(info: ClassInfo, inject: Literal | undefined, optionsNode: AstNode | undefined, decorator: string): DependencyRef[] | undefined {
    const hint = `List the dependencies explicitly with @${decorator}({ inject: [ClassOrToken, ...] }), or annotate the parameter with a class or an interface that has a same-named token.`;
    if (inject !== undefined) {
      if (!Array.isArray(inject) || inject.some((r) => !(r instanceof Ref))) {
        this.error('invalid-option', info.mod, (optionsNode && propertyNode(optionsNode, 'inject')) ?? info.node, `@${decorator} on ${info.name}: inject must list classes or tokens`);
        return undefined;
      }
      const refs = (inject as Ref[]).map((r) => this.resolveKey(info.mod, r.name, r.node, info.name, `inject entry ${r.name}`, hint));
      return refs.every((r) => r) ? (refs as DependencyRef[]) : undefined;
    }
    let ctor: { member: Member } | undefined;
    for (const cls of this.chain(info).toReversed()) {
      const member = cls.members.find((m) => m.node.type === 'MethodDefinition' && m.node.kind === 'constructor');
      if (member) {
        ctor = { member };
        break;
      }
    }
    if (!ctor) return [];
    const { mod } = ctor.member;
    const deps: Array<DependencyRef | undefined> = [];
    for (const raw of ctor.member.node.value.params as AstNode[]) {
      let param = raw.type === 'TSParameterProperty' ? raw.parameter : raw;
      if (param.type === 'RestElement') {
        this.error('unsupported-type', mod, raw, `${info.name}'s constructor has a rest parameter, which cannot be injected`, hint);
        deps.push(undefined);
        continue;
      }
      if (param.type === 'AssignmentPattern') param = param.left;
      const paramName = param.type === 'Identifier' ? param.name : 'parameter';
      const type = param.typeAnnotation?.typeAnnotation as AstNode | undefined;
      if (!type) {
        this.error('missing-annotation', mod, raw, `Constructor parameter "${paramName}" of ${info.name} has no type annotation, so norn gen cannot infer what to inject`, hint);
        deps.push(undefined);
        continue;
      }
      deps.push(this.typeKey(mod, type, info.name, paramName, hint));
    }
    return deps.every((d) => d) ? (deps as DependencyRef[]) : undefined;
  }

  private typeKey(mod: ParsedModule, type: AstNode, className: string, param: string, hint: string): DependencyRef | undefined {
    const text = mod.code.slice(type.start, type.end);
    const what = `Parameter "${param}" of ${className}`;
    const unsupported = (description: string) => {
      this.error('unsupported-type', mod, type, `${what} has ${description}, which cannot identify a dependency`, hint);
      return undefined;
    };
    if (type.type === 'TSTypeReference') {
      if (type.typeArguments) return unsupported(`the generic type ${text}`);
      if (type.typeName.type === 'Identifier') return this.resolveKey(mod, type.typeName.name, type, className, `${what}'s type ${type.typeName.name}`, hint);
      if (type.typeName.type === 'TSQualifiedName' && type.typeName.left.type === 'Identifier') {
        const ns = mod.bindings.get(type.typeName.left.name);
        if (ns?.imported === '*') {
          const name = type.typeName.right.name as string;
          if (!isRelative(ns.source)) return { module: { kind: 'package', specifier: ns.source }, name };
          const target = this.project.resolve(mod.file, ns.source);
          if (target && this.project.exportsValue(target, name)) return this.canonical(target, name);
        }
      }
      return unsupported(`the type ${text}`);
    }
    if (/^TS\w+Keyword$/.test(type.type)) return unsupported(`the primitive type ${text}`);
    if (type.type === 'TSUnionType') return unsupported(`a union type (${text})`);
    if (type.type === 'TSIntersectionType') return unsupported(`an intersection type (${text})`);
    return unsupported(`the type ${text}`);
  }

  /** Resolves a name used as a dependency key to the module that exports its value. */
  private resolveKey(mod: ParsedModule, name: string, node: AstNode, className: string, what: string, hint: string): DependencyRef | undefined {
    const rel = this.project.rel(mod.file);
    const tokenHint = `Declare a token next to the interface: export const ${name} = token<${name}>('${name}'). Or ${hint[0]!.toLowerCase()}${hint.slice(1)}`;
    const binding = mod.bindings.get(name);
    if (binding) {
      if (binding.imported === '*' || binding.imported === 'default') {
        this.error('unsupported-type', mod, node, `${what} is a ${binding.imported === '*' ? 'namespace' : 'default'} import, which cannot be imported by name`, hint);
        return undefined;
      }
      if (!isRelative(binding.source)) return { module: { kind: 'package', specifier: binding.source }, name: binding.imported };
      const target = this.project.resolve(mod.file, binding.source);
      if (!target) {
        this.error('unresolved-type', mod, node, `${what}: cannot resolve "${binding.source}" from ${rel}`, hint);
        return undefined;
      }
      if (this.project.exportsValue(target, binding.imported)) return this.canonical(target, binding.imported);
      this.error(
        'interface-without-token',
        mod,
        node,
        `${name} is only a type in ${this.project.rel(target)}: that module has no value export named ${binding.imported} to inject for ${className}`,
        tokenHint,
      );
      return undefined;
    }
    const decls = mod.declarations.get(name);
    if (decls) {
      if (decls.some((d) => d.hasValue)) {
        const exported = exportNamesOf(mod, name).filter((n) => n !== 'default');
        if (exported.length > 0) return { module: { kind: 'file', path: mod.file }, name: exported.includes(name) ? name : exported[0]! };
        this.error('not-exported', mod, node, `${name} (used by ${className}) must be exported from ${rel} so the container can import it`, `Write export before its declaration.`);
        return undefined;
      }
      this.error('interface-without-token', mod, node, `${name} is only a type (${decls[0]!.kind === 'interface' ? 'an interface' : 'a type alias'} in ${rel}) with no value to inject for ${className}`, tokenHint);
      return undefined;
    }
    this.error('unresolved-type', mod, node, `${what}: ${name} is not imported or declared in ${rel}`, hint);
    return undefined;
  }

  /** The module that declares an exported value, so re-exports of one value import it once. */
  private canonical(file: string, name: string): DependencyRef {
    const found = this.project.findExport(file, name);
    if (found) {
      const mod = this.project.module(found.file);
      const names = exportNamesOf(mod, found.local).filter((n) => n !== 'default');
      if (names.length > 0 && mod.declarations.get(found.local)?.some((d) => d.hasValue)) {
        return { module: { kind: 'file', path: found.file }, name: names.includes(found.local) ? found.local : names.toSorted()[0]! };
      }
    }
    return { module: { kind: 'file', path: file }, name };
  }

  private checkDuplicates(workflows: WorkflowModel[], activities: ActivitiesModel[]): void {
    const byName = new Map<string, WorkflowModel>();
    for (const wf of workflows) {
      const first = byName.get(wf.name);
      if (first) {
        this.errors.push({
          code: 'duplicate-workflow',
          message: `Workflow type "${wf.name}" (${wf.className}) is already declared at ${this.where(first.loc)} (${first.className})`,
          ...wf.loc,
          hint: "Workflow type names must be unique: rename one, or set @Workflow({ name: '...' }).",
        });
      } else byName.set(wf.name, wf);
    }

    const owners = new Map<string, { cls: ActivitiesModel; method: ActivityMethodModel }>();
    const classNames = new Map<string, ActivitiesModel>();
    for (const cls of activities) {
      const firstClass = classNames.get(cls.className);
      if (firstClass) {
        this.errors.push({
          code: 'duplicate-class',
          message: `@Activities class name ${cls.className} is also used in ${this.project.rel(firstClass.file)}; the generated activities file exports one reference per class name`,
          ...cls.loc,
          hint: 'Rename one of the classes.',
        });
      } else classNames.set(cls.className, cls);
      for (const method of cls.methods) {
        const owner = owners.get(method.name);
        if (owner && owner.cls !== cls) {
          this.errors.push({
            code: 'duplicate-activity',
            message: `Activity "${method.name}" is registered by both ${owner.cls.className} (${this.where(owner.method.loc)}) and ${cls.className}`,
            ...method.loc,
            hint: 'Activity names (prefix + name) must be unique across the worker: change a prefix or a name.',
          });
        } else if (!owner) owners.set(method.name, { cls, method });
      }
    }

    const attributes = new Map<string, { type: SearchAttributeType; loc: Location; workflow: string }>();
    const schedules = new Map<string, ScheduleModel>();
    for (const wf of workflows) {
      for (const [key, type] of Object.entries(wf.searchAttributes)) {
        const first = attributes.get(key);
        if (first && first.type !== type) {
          this.errors.push({
            code: 'search-attribute-conflict',
            message: `Search attribute ${key} is declared as "${type}" here but as "${first.type}" at ${this.where(first.loc)} (${first.workflow}); a search attribute has one type per namespace`,
            ...wf.searchAttributeLocs[key]!,
            hint: 'Use the same type everywhere, or a different attribute name.',
          });
        } else if (!first) attributes.set(key, { type, loc: wf.searchAttributeLocs[key]!, workflow: wf.name });
      }
      for (const s of wf.schedules) {
        const first = schedules.get(s.id);
        if (first) {
          this.errors.push({
            code: 'duplicate-schedule',
            message: `Schedule id "${s.id}" is already used at ${this.where(first.loc)}`,
            ...s.loc,
            hint: "Give each schedule a unique id with @Schedule(cron, { id: '...' }).",
          });
        } else schedules.set(s.id, s);
      }
    }
  }
}

const FAILED = Symbol('failed');

export function propertyNode(objectNode: AstNode, key: string): AstNode | undefined {
  let node = objectNode;
  while (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'ParenthesizedExpression') node = node.expression;
  if (node.type !== 'ObjectExpression') return undefined;
  for (const p of node.properties as AstNode[]) {
    if (p.type !== 'Property') continue;
    const k = !p.computed && p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : undefined;
    if (k === key) return p;
  }
  return undefined;
}

export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
