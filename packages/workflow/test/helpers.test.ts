import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NornConfigError } from '@norn-ts/core';
import { Workflow, implement, setSearchAttributes } from '../src/index.ts';

const upserts = vi.hoisted(() => [] as unknown[]);
vi.mock('@temporalio/workflow', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  workflowInfo: () => ({ workflowType: 'SearchableWorkflow' }),
  upsertSearchAttributes: (pairs: unknown) => upserts.push(pairs),
}));

@Workflow({
  taskQueue: 'q',
  searchAttributes: {
    Customer: 'keyword',
    Notes: 'text',
    Count: 'int',
    Score: 'double',
    Vip: 'bool',
    PlacedAt: 'datetime',
    Tags: 'keywordList',
  },
})
class SearchableWorkflow {
  async run() {}
}
implement(SearchableWorkflow);

beforeEach(() => {
  upserts.length = 0;
});

describe('setSearchAttributes', () => {
  it('upserts declared attributes with their Temporal types', () => {
    const placedAt = new Date('2026-10-19T00:00:00Z');
    setSearchAttributes({ Customer: 'c1', Notes: 'n', Count: 2, Score: 1.5, Vip: true, PlacedAt: placedAt, Tags: ['a'] });
    expect(upserts[0]).toEqual([
      { key: { name: 'Customer', type: 'KEYWORD' }, value: 'c1' },
      { key: { name: 'Notes', type: 'TEXT' }, value: 'n' },
      { key: { name: 'Count', type: 'INT' }, value: 2 },
      { key: { name: 'Score', type: 'DOUBLE' }, value: 1.5 },
      { key: { name: 'Vip', type: 'BOOL' }, value: true },
      { key: { name: 'PlacedAt', type: 'DATETIME' }, value: placedAt },
      { key: { name: 'Tags', type: 'KEYWORD_LIST' }, value: ['a'] },
    ]);
  });

  it('accepts null to clear an attribute', () => {
    setSearchAttributes({ Count: null });
    expect(upserts[0]).toEqual([{ key: { name: 'Count', type: 'INT' }, value: null }]);
  });

  it.each(['Unknown', 'constructor', 'toString', '__proto__'])('rejects undeclared name %s', (name) => {
    expect(() => setSearchAttributes(JSON.parse(`{"${name}": "x"}`))).toThrow(NornConfigError);
    expect(upserts).toEqual([]);
  });

  it.each([
    { Customer: 1 },
    { Notes: false },
    { Count: 1.5 },
    { Count: '2' },
    { Score: Number.NaN },
    { Score: '1.5' },
    { Vip: 'true' },
    { PlacedAt: '2026-10-19' },
    { PlacedAt: new Date('nope') },
    { Tags: 'a' },
    { Tags: ['a', 1] },
  ])('rejects a value of the wrong type %j', (values) => {
    expect(() => setSearchAttributes(values as never)).toThrow(NornConfigError);
    expect(upserts).toEqual([]);
  });
});
