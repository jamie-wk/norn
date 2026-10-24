import { expect, it } from 'vitest';
import * as client from '../../src/client/index.ts';

it('exports only the documented client API', () => {
  for (const internal of ['failureTypeOf', 'toTypedSearchAttributes', 'startOptions', 'resolveWorkflowId']) {
    expect(Object.keys(client)).not.toContain(internal);
  }
  expect(Object.keys(client)).toContain('createClient');
  expect(Object.keys(client)).toContain('toNornError');
});
