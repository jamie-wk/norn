import { describe, expect, it } from 'vitest';
import { defaultDeny } from '../../eslint-plugin/src/rules/no-activity-imports.ts';
import { defaultGlobals, temporalPolyfill } from '../../eslint-plugin/src/rules/workflow-determinism.ts';
import { IDENTIFIER } from '../../core/src/id-template.ts';
import { IDENTIFIER as CLI_IDENTIFIER } from '../src/analyze.ts';
import { TEMPORAL_POLYFILL, WATCHED, WORKER_ONLY_PACKAGES } from '../src/checks.ts';

describe('workflow code checks', () => {
  it('flag the same packages and globals as the ESLint plugin', () => {
    expect(WORKER_ONLY_PACKAGES).toEqual(defaultDeny);
    expect([...WATCHED]).toEqual(defaultGlobals);
    expect(TEMPORAL_POLYFILL.source).toBe(temporalPolyfill.source);
  });

  it('validate names with the same identifier rule as @norn-ts/core', () => {
    expect(CLI_IDENTIFIER.source).toBe(IDENTIFIER.source);
  });
});
