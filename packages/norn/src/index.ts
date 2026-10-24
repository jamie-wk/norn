/**
 * Norn: write Temporal workflows and activities as plain, typed TypeScript classes.
 *
 * Import from the subpath for where the code runs:
 * - `@norn-ts/norn/workflow`: decorators and helpers for workflow code (safe in the sandbox)
 * - `@norn-ts/norn/worker`: `createWorker()`
 * - `@norn-ts/norn/client`: `createClient()`
 * - `@norn-ts/norn/testing`, `/vitest`, `/vite`: test environment and tooling
 *
 * This entry exports the error types, options and duration helpers shared by all of them. It is
 * safe in workflow code.
 */
export {
  NornError,
  NornConfigError,
  QueryFailedError,
  TemporalUnavailableError,
  UpdateRejectedError,
  WorkflowAlreadyStartedError,
  WorkflowClosedError,
  WorkflowFailedError,
  WorkflowNotFoundError,
  isNornError,
  toMs,
  type ActivityOptions,
  type Duration,
  type RetryOptions,
  type SearchAttributeType,
} from './core/index.js';
