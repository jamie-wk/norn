/**
 * Error types shared by every Norn package.
 *
 * Each error has a stable `code` and an HTTP `status`, so API adapters can map failures to
 * responses without string matching, and keeps the original SDK error as `cause`.
 */

export interface NornErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class NornError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, status: number, message: string, options: NornErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = options.details ?? {};
  }

  /** A response-safe shape: no stack, no cause. */
  toJSON(): { code: string; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** Invalid configuration or decorator options. Thrown at definition time, never at runtime in a workflow. */
export class NornConfigError extends NornError {
  constructor(message: string, options: NornErrorOptions = {}) {
    super('CONFIG', 500, message, options);
  }
}

export class WorkflowAlreadyStartedError extends NornError {
  readonly workflowId: string;
  constructor(args: { workflowId: string; workflowType?: string; cause?: unknown }) {
    super('WORKFLOW_ALREADY_STARTED', 409, `Workflow ${args.workflowId} is already running`, {
      cause: args.cause,
      details: { workflowId: args.workflowId, ...(args.workflowType ? { workflowType: args.workflowType } : {}) },
    });
    this.workflowId = args.workflowId;
  }
}

export class WorkflowNotFoundError extends NornError {
  readonly workflowId: string;
  constructor(args: { workflowId: string; runId?: string; cause?: unknown }) {
    super('WORKFLOW_NOT_FOUND', 404, `Workflow ${args.workflowId} was not found`, {
      cause: args.cause,
      details: { workflowId: args.workflowId, ...(args.runId ? { runId: args.runId } : {}) },
    });
    this.workflowId = args.workflowId;
  }
}

export class WorkflowClosedError extends NornError {
  readonly workflowId: string;
  readonly closeStatus: string;
  constructor(args: { workflowId: string; closeStatus: string; cause?: unknown }) {
    super('WORKFLOW_CLOSED', 409, `Workflow ${args.workflowId} is already closed (${args.closeStatus})`, {
      cause: args.cause,
      details: { workflowId: args.workflowId, closeStatus: args.closeStatus },
    });
    this.workflowId = args.workflowId;
    this.closeStatus = args.closeStatus;
  }
}

/** An update was rejected by its validator, or its handler threw an ApplicationFailure. */
export class UpdateRejectedError extends NornError {
  readonly workflowId: string;
  readonly update: string;
  readonly failureType: string;
  constructor(args: { workflowId: string; update: string; failureType: string; message: string; cause?: unknown }) {
    super('UPDATE_REJECTED', 422, args.message, {
      cause: args.cause,
      details: { workflowId: args.workflowId, update: args.update, failureType: args.failureType },
    });
    this.workflowId = args.workflowId;
    this.update = args.update;
    this.failureType = args.failureType;
  }
}

export class QueryFailedError extends NornError {
  constructor(args: { workflowId: string; query: string; message: string; cause?: unknown }) {
    super('QUERY_FAILED', 500, args.message, {
      cause: args.cause,
      details: { workflowId: args.workflowId, query: args.query },
    });
  }
}

export class WorkflowFailedError extends NornError {
  readonly workflowId: string;
  readonly failureType: string;
  constructor(args: { workflowId: string; failureType: string; message: string; cause?: unknown }) {
    super('WORKFLOW_FAILED', 500, args.message, {
      cause: args.cause,
      details: { workflowId: args.workflowId, failureType: args.failureType },
    });
    this.workflowId = args.workflowId;
    this.failureType = args.failureType;
  }
}

export class TemporalUnavailableError extends NornError {
  constructor(args: { message: string; cause?: unknown }) {
    super('TEMPORAL_UNAVAILABLE', 503, args.message, { cause: args.cause });
  }
}

export function isNornError(value: unknown): value is NornError {
  return value instanceof NornError;
}

/**
 * The failure type Norn records for an error: a custom `name` when set, otherwise the class name.
 * Activities and workflows use the same rule, so `isFailure(e, MyError)` matches what was thrown.
 */
export function errorTypeOf(error: unknown): string {
  if (!(error instanceof Error)) return 'Error';
  if (error.name && error.name !== 'Error') return error.name;
  const ctor = (error as { constructor?: { name?: string } }).constructor;
  return ctor?.name && ctor.name !== 'Object' ? ctor.name : 'Error';
}
