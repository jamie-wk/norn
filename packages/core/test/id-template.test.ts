import { describe, expect, it } from 'vitest';
import { formatWorkflowId, templateKeys, NornConfigError } from '../src/index.ts';

describe('templateKeys', () => {
  it('lists placeholders in order without duplicates', () => {
    expect(templateKeys('order-{orderId}')).toEqual(['orderId']);
    expect(templateKeys('pay_{companyId}_{paymentId}_{companyId}')).toEqual(['companyId', 'paymentId']);
    expect(templateKeys('singleton')).toEqual([]);
  });

  it.each(['order-{', 'order-}', 'order-{}', 'order-{a-b}', 'x-{a{b}}'])('rejects malformed template %j', (t) => {
    expect(() => templateKeys(t)).toThrow(NornConfigError);
  });
});

describe('formatWorkflowId', () => {
  it('fills placeholders from the input', () => {
    expect(formatWorkflowId('order-{orderId}', { orderId: 'o1', other: 1 })).toBe('order-o1');
    expect(formatWorkflowId('n-{n}', { n: 42 })).toBe('n-42');
    expect(formatWorkflowId('static', {})).toBe('static');
  });

  it('fails when a placeholder value is missing or empty', () => {
    expect(() => formatWorkflowId('order-{orderId}', {})).toThrow(/orderId/);
    expect(() => formatWorkflowId('order-{orderId}', { orderId: '' })).toThrow(/orderId/);
    expect(() => formatWorkflowId('order-{orderId}', { orderId: null })).toThrow(/orderId/);
  });

  it('fails when a placeholder value is not a string, number or bigint', () => {
    expect(() => formatWorkflowId('order-{orderId}', { orderId: { id: 1 } })).toThrow(/orderId/);
  });

  it('fails when the input is not an object', () => {
    expect(() => formatWorkflowId('order-{orderId}', undefined)).toThrow(NornConfigError);
  });
});
