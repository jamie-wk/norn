/**
 * Workflow-side interceptors, bundled into the workflow sandbox. Imports only workflow-safe
 * modules. Each workflow execution gets its own instance.
 */
import type { Payload } from '@temporalio/common';
import type { WorkflowInterceptors } from '@temporalio/workflow';
import { CORRELATION_HEADER } from '@norn/core';

type WithHeaders = { headers: Record<string, Payload> };

export const interceptors = (): WorkflowInterceptors => {
  let correlation: Payload | undefined;
  const forward = <I extends WithHeaders>(input: I): I =>
    correlation === undefined || input.headers[CORRELATION_HEADER] !== undefined
      ? input
      : { ...input, headers: { ...input.headers, [CORRELATION_HEADER]: correlation } };
  return {
    inbound: [
      {
        execute(input, next) {
          correlation = input.headers[CORRELATION_HEADER];
          return next(input);
        },
      },
    ],
    outbound: [
      {
        scheduleActivity: (input, next) => next(forward(input)),
        scheduleLocalActivity: (input, next) => next(forward(input)),
        startChildWorkflowExecution: (input, next) => next(forward(input)),
        signalWorkflow: (input, next) => next(forward(input)),
        continueAsNew: (input, next) => next(forward(input)),
      },
    ],
  };
};
