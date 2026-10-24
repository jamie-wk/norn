import { describe, expect, it } from 'vitest';
import type { Client } from '@temporalio/client';
import { importPath } from '../src/emit.ts';
import { historyFileName, pullHistories } from '../src/histories.ts';
import { overlapPolicy, readSchedules, specHash } from '../src/schedules.ts';
import { connectionSettings } from '../src/temporal.ts';
import { project, removeDir } from './helpers.ts';

describe('connection settings', () => {
  it('defaults to a local dev server', () => {
    expect(connectionSettings({})).toEqual({ address: 'localhost:7233', namespace: 'default', apiKey: undefined, tls: false });
  });

  it('enables TLS with an API key, or explicitly', () => {
    expect(connectionSettings({ TEMPORAL_ADDRESS: 'ns.acct.tmprl.cloud:7233', TEMPORAL_NAMESPACE: 'ns.acct', TEMPORAL_API_KEY: 'k' })).toEqual({
      address: 'ns.acct.tmprl.cloud:7233',
      namespace: 'ns.acct',
      apiKey: 'k',
      tls: true,
    });
    expect(connectionSettings({ TEMPORAL_TLS: 'true' }).tls).toBe(true);
  });

  it('reads mTLS certificates and requires both files', () => {
    const dir = project({ 'c.pem': 'CERT', 'k.pem': 'KEY' });
    try {
      const { tls } = connectionSettings({ TEMPORAL_TLS_CERT: `${dir}/c.pem`, TEMPORAL_TLS_KEY: `${dir}/k.pem` });
      expect(tls).toEqual({ clientCertPair: { crt: Buffer.from('CERT'), key: Buffer.from('KEY') } });
      expect(() => connectionSettings({ TEMPORAL_TLS_CERT: `${dir}/c.pem` })).toThrow(/both/);
      // Empty means unset, as for every other variable.
      expect(connectionSettings({ TEMPORAL_TLS_CERT: '' }).tls).toBe(false);
    } finally {
      removeDir(dir);
    }
  });
});

describe('schedule helpers', () => {
  const spec = { id: 'a', workflowType: 'W', taskQueue: 'q', cron: ['0 * * * *'] };

  it('maps overlap policies', () => {
    expect(overlapPolicy(undefined)).toBe('SKIP');
    expect(overlapPolicy('buffer-one')).toBe('BUFFER_ONE');
    expect(overlapPolicy('terminate-other')).toBe('TERMINATE_OTHER');
  });

  it('hashes specs independently of key order', () => {
    expect(specHash({ ...spec, input: { a: 1, b: 2 } })).toBe(specHash({ cron: ['0 * * * *'], taskQueue: 'q', workflowType: 'W', id: 'a', input: { b: 2, a: 1 } }));
    expect(specHash(spec)).not.toBe(specHash({ ...spec, cron: ['0 1 * * *'] }));
  });

  it('validates schedules.json', () => {
    const dir = project({ 'ok.json': JSON.stringify([spec]), 'bad.json': '[{"id": 1}]', 'obj.json': '{}' });
    try {
      expect(readSchedules(`${dir}/ok.json`)).toEqual([spec]);
      expect(() => readSchedules(`${dir}/bad.json`)).toThrow(/needs id, workflowType/);
      expect(() => readSchedules(`${dir}/obj.json`)).toThrow(/array/);
      expect(() => readSchedules(`${dir}/missing.json`)).toThrow(/Run norn gen first/);
    } finally {
      removeDir(dir);
    }
  });

  it('makes workflow IDs safe file names', () => {
    expect(historyFileName('order-123')).toBe('order-123.json');
    expect(historyFileName('tenant/a b:c')).toBe('tenant_a_b_c.json');
  });

  it('refuses workflow IDs that map to the same file name', async () => {
    const client = { workflow: { getHandle: () => ({ fetchHistory: async () => ({ events: [] }) }) } } as unknown as Client;
    await expect(pullHistories({ client, workflowIds: ['a/b', 'a:b'], outDir: '/nonexistent/histories' })).rejects.toThrow(/"a\/b" and "a:b" both map to a_b\.json/);
  });
});

describe('generated import paths', () => {
  it('always start with ./ or ../', () => {
    expect(importPath('/p/.norn', '/p/src/a.ts', '.js')).toBe('../src/a.js');
    expect(importPath('/p/.norn', '/p/.norn/.hidden/a.ts', '.js')).toBe('./.hidden/a.js');
    expect(importPath('/p', '/p/..x/a.mts', '.ts')).toBe('./..x/a.mts');
  });
});
