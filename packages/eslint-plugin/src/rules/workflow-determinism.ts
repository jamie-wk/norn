import type { Rule } from 'eslint';
import { type Node, docsUrl, findGlobalUses, parentMember, propertyName, staticString } from '../utils.js';

export interface WorkflowDeterminismOptions {
  /**
   * Also report `Date.now()`, `new Date()` / `Date()` with no arguments, and `Math.random()`.
   * The Temporal workflow sandbox already makes these deterministic, so they are allowed by default.
   */
  strict?: boolean;
}

/** Modules whose `Temporal` export has a `Temporal.Now` that reads the real clock, like the built-in. */
export const temporalPolyfill = /^(?:@js-temporal\/polyfill|temporal-polyfill)(?:\/.*)?$/;

export const defaultGlobals: readonly string[] = [
  'setTimeout',
  'setInterval',
  'setImmediate',
  'process',
  'Temporal',
  'crypto',
  'performance',
  'WeakRef',
  'FinalizationRegistry',
];

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow non-deterministic or sandbox-unavailable APIs (timers, process, Temporal.Now, crypto, performance) in workflow code',
      recommended: true,
      url: docsUrl('workflow-determinism'),
    },
    schema: [
      {
        type: 'object',
        properties: { strict: { type: 'boolean' } },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ strict: false }],
    messages: {
      setTimeout:
        "Use `await sleep(ms)` from '@temporalio/workflow' instead of `setTimeout` in workflow code (or `await condition(() => ..., timeout)` to wait for workflow state). The sandbox only emulates `setTimeout` with a durable timer, and a callback timer is easy to leave running past the code that needed it.",
      unavailableTimer:
        "`{{name}}` does not exist in the Temporal workflow sandbox. Use `await sleep(ms)` from '@temporalio/workflow' (in a loop for periodic work), or `await condition(() => ..., timeout)` to wait for workflow state.",
      process:
        '`{{expr}}` is not available in the Temporal workflow sandbox, and environment variables, timers and host state differ between the original run and a replay. Pass configuration in as workflow input, or read it in an activity.',
      temporalNow:
        '`{{expr}}` reads the real wall clock: the workflow sandbox makes `Date` deterministic but does not patch the TC39 Temporal API, so a replay would see a different time. Derive it from workflow time instead, e.g. `Temporal.Instant.fromEpochMilliseconds(Date.now())`, or use the timestamps on `workflowInfo()`.',
      crypto:
        "`{{expr}}` is non-deterministic and Web Crypto is not available in the Temporal workflow sandbox. Use `uuid4()` from '@temporalio/workflow' for IDs, or `Math.random()`, which the sandbox seeds deterministically. Do real cryptography in an activity.",
      performance:
        '`{{expr}}` reads a real high-resolution clock that the Temporal workflow sandbox does not make deterministic (and may not provide). Use `Date.now()`, which returns deterministic workflow time inside a workflow, or measure timings in an activity.',
      gc: '`{{name}}` throws a DeterminismViolationError in Temporal workflows because garbage collection timing is non-deterministic. Keep a strong reference, or store the data in workflow state.',
      strictDateNow:
        "`Date.now()` is disallowed by this rule's `strict` option. (Inside the workflow sandbox it returns the deterministic time of the current workflow task.) Pass timestamps in as input, or use `workflowInfo()` timestamps such as `workflowInfo().startTime`.",
      strictNewDate:
        "`{{expr}}` without arguments reads the current time and is disallowed by this rule's `strict` option. (Inside the workflow sandbox it returns the deterministic workflow task time.) Pass timestamps in as input, use `workflowInfo().startTime`, or construct the date from an explicit value.",
      strictMathRandom:
        "`Math.random()` is disallowed by this rule's `strict` option. (Inside the workflow sandbox it is seeded per run and replays identically.) Use `uuid4()` from '@temporalio/workflow' for IDs, or pass the random input in from an activity.",
    },
  },

  create(context) {
    const [{ strict = false } = {}] = context.options as [WorkflowDeterminismOptions?];
    const sourceCode = context.sourceCode;
    const text = (node: Node) => sourceCode.getText(node);

    /** Reports `Temporal.Now`, `Temporal.Now.x` and `const { Now } = Temporal` uses of a `Temporal` node. */
    const checkTemporal = (node: Node) => {
      const now = parentMember(node);
      if (now) {
        if (propertyName(now) !== 'Now') return;
        const method = parentMember(now);
        const target = method ?? now;
        context.report({ node: target, messageId: 'temporalNow', data: { expr: text(target) } });
        return;
      }
      const parent = node.parent;
      if (parent?.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'ObjectPattern') {
        const destructuresNow = parent.id.properties.some(
          (p) => p.type === 'Property' && (p.key.type === 'Identifier' ? p.key.name : staticString(p.key)) === 'Now',
        );
        if (destructuresNow) context.report({ node, messageId: 'temporalNow', data: { expr: text(node) } });
      }
    };

    /** The node to report for an object-like global: the `x.y` member when there is one, else the global itself. */
    const memberOrSelf = (node: Node) => parentMember(node) ?? node;

    const globals = new Set(strict ? [...defaultGlobals, 'Date', 'Math'] : defaultGlobals);

    return {
      ImportDeclaration(node) {
        if (!temporalPolyfill.test(String(node.source.value))) return;
        for (const variable of sourceCode.getDeclaredVariables(node)) {
          const def = variable.defs[0];
          const imported =
            def?.node.type === 'ImportSpecifier'
              ? def.node.imported.type === 'Identifier'
                ? def.node.imported.name
                : def.node.imported.value
              : undefined;
          if (imported !== 'Temporal') continue;
          for (const ref of variable.references) checkTemporal(ref.identifier as Node);
        }
      },

      'Program:exit'() {
        for (const { name, node } of findGlobalUses(sourceCode, globals)) {
          switch (name) {
            case 'setTimeout':
              context.report({ node, messageId: 'setTimeout' });
              break;
            case 'setInterval':
            case 'setImmediate':
              context.report({ node, messageId: 'unavailableTimer', data: { name } });
              break;
            case 'WeakRef':
            case 'FinalizationRegistry':
              context.report({ node, messageId: 'gc', data: { name } });
              break;
            case 'process':
            case 'crypto':
            case 'performance': {
              const target = memberOrSelf(node);
              context.report({ node: target, messageId: name, data: { expr: text(target) } });
              break;
            }
            case 'Temporal':
              checkTemporal(node);
              break;
            case 'Date': {
              const member = parentMember(node);
              const parent = node.parent;
              if (member && propertyName(member) === 'now') {
                context.report({ node: member, messageId: 'strictDateNow' });
              } else if (
                (parent?.type === 'NewExpression' || parent?.type === 'CallExpression') &&
                parent.callee === node &&
                parent.arguments.length === 0
              ) {
                context.report({ node: parent, messageId: 'strictNewDate', data: { expr: text(parent) } });
              }
              break;
            }
            case 'Math': {
              const member = parentMember(node);
              if (member && propertyName(member) === 'random') {
                context.report({ node: member, messageId: 'strictMathRandom' });
              }
              break;
            }
          }
        }
      },
    };
  },
};

export default rule;
