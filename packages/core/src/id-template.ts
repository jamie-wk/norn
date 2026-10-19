import { NornConfigError } from './errors.js';

/** The placeholder names in an ID template, such as `'orderId'` for `'order-{orderId}'`. */
export type TemplateKeys<T extends string> = string extends T
  ? string
  : T extends `${string}{${infer Key}}${infer Rest}`
    ? Key | TemplateKeys<Rest>
    : never;

/** Template keys that are missing from `Input`; `never` when the template is valid. */
export type MissingTemplateKeys<T extends string, Input> = Exclude<TemplateKeys<T>, keyof NonNullable<Input>>;

const PLACEHOLDER = /\{([^{}]*)\}/g;
const KEY = /^[A-Za-z_$][\w$]*$/;

/** Lists the placeholder names in an ID template. Throws on malformed templates. */
export function templateKeys(template: string): string[] {
  const keys: string[] = [];
  const stripped = template.replace(PLACEHOLDER, (_match, key: string) => {
    if (!KEY.test(key)) {
      throw new NornConfigError(`Invalid ID template ${JSON.stringify(template)}: "{${key}}" is not a field name`);
    }
    if (!keys.includes(key)) keys.push(key);
    return '';
  });
  if (stripped.includes('{') || stripped.includes('}')) {
    throw new NornConfigError(`Invalid ID template ${JSON.stringify(template)}: unbalanced braces`);
  }
  return keys;
}

/** Builds a workflow ID by filling the template's placeholders from `input`. */
export function formatWorkflowId(template: string, input: unknown): string {
  const keys = templateKeys(template);
  if (keys.length === 0) return template;
  if (typeof input !== 'object' || input === null) {
    throw new NornConfigError(
      `Cannot build a workflow ID from template ${JSON.stringify(template)}: input is ${input === null ? 'null' : typeof input}`,
    );
  }
  const record = input as Record<string, unknown>;
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = record[key];
    if (value === undefined || value === null || value === '') {
      throw new NornConfigError(`Cannot build a workflow ID from template ${JSON.stringify(template)}: "${key}" is empty`);
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
      throw new NornConfigError(
        `Cannot build a workflow ID from template ${JSON.stringify(template)}: "${key}" must be a string or number`,
      );
    }
    return String(value);
  });
}
