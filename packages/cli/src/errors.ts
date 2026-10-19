/** Every kind of problem `norn gen` reports. */
export type NornGenErrorCode =
  | 'config'
  | 'parse-error'
  | 'non-literal'
  | 'invalid-option'
  | 'invalid-decorator'
  | 'invalid-member'
  | 'invalid-validate'
  | 'missing-run'
  | 'not-exported'
  | 'missing-annotation'
  | 'unsupported-type'
  | 'unresolved-type'
  | 'interface-without-token'
  | 'duplicate-workflow'
  | 'duplicate-handler'
  | 'duplicate-activity'
  | 'duplicate-class'
  | 'duplicate-schedule'
  | 'search-attribute-conflict'
  | 'import-boundary'
  | 'determinism'
  | 'lock-removed'
  | 'lock-invalid';

/** A problem found by `norn gen`. Paths are relative to the project root (the config file's directory). */
export interface NornGenError {
  code: NornGenErrorCode;
  message: string;
  file?: string;
  /** 1-based. */
  line?: number;
  /** 1-based. */
  column?: number;
  /** How to fix it. */
  hint?: string;
}

/** Formats an error like a compiler diagnostic: `src/x.ts:3:5 - error norn(code): message`. */
export function formatError(error: NornGenError): string {
  let where = '';
  if (error.file) {
    where = error.file;
    if (error.line !== undefined) where += `:${error.line}`;
    if (error.line !== undefined && error.column !== undefined) where += `:${error.column}`;
    where += ' - ';
  }
  const text = `${where}error norn(${error.code}): ${error.message}`;
  return error.hint ? `${text}\n  hint: ${error.hint}` : text;
}

/** Errors are reported in file, line, column order. */
export function sortErrors(errors: NornGenError[]): NornGenError[] {
  const key = (e: NornGenError) => [e.file ?? '', e.line ?? 0, e.column ?? 0] as const;
  return errors.toSorted((a, b) => {
    const [fa, la, ca] = key(a);
    const [fb, lb, cb] = key(b);
    return fa < fb ? -1 : fa > fb ? 1 : la - lb || ca - cb;
  });
}

/** Thrown for problems that stop generation before any source is read, such as a broken config. */
export class NornGenFailure extends Error {
  readonly errors: NornGenError[];
  constructor(errors: NornGenError[]) {
    super(errors.map(formatError).join('\n'));
    this.name = 'NornGenFailure';
    this.errors = errors;
  }
}
