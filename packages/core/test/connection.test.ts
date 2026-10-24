import { describe, expect, it } from 'vitest';
import { NornConfigError, connectionSettings } from '../src/index.ts';

describe('connectionSettings', () => {
  it('defaults to a local dev server', () => {
    expect(connectionSettings({})).toEqual({ address: 'localhost:7233', namespace: 'default', apiKey: undefined, tls: false, clientCert: undefined });
  });

  it('reads the environment, and an API key turns TLS on', () => {
    expect(connectionSettings({ TEMPORAL_ADDRESS: 'ns.acct.tmprl.cloud:7233', TEMPORAL_NAMESPACE: 'ns.acct', TEMPORAL_API_KEY: 'k' })).toEqual({
      address: 'ns.acct.tmprl.cloud:7233',
      namespace: 'ns.acct',
      apiKey: 'k',
      tls: true,
      clientCert: undefined,
    });
    expect(connectionSettings({ TEMPORAL_TLS: 'true' }).tls).toBe(true);
  });

  it('lets options win over the environment', () => {
    const settings = connectionSettings(
      { TEMPORAL_ADDRESS: 'env:7233', TEMPORAL_NAMESPACE: 'env', TEMPORAL_API_KEY: 'env-key' },
      { address: 'opt:7233', namespace: 'opt', apiKey: 'opt-key', tls: false },
    );
    expect(settings).toMatchObject({ address: 'opt:7233', namespace: 'opt', apiKey: 'opt-key', tls: false });
  });

  it('treats empty values as unset, in the environment and in options', () => {
    const env = { TEMPORAL_ADDRESS: '', TEMPORAL_NAMESPACE: '', TEMPORAL_API_KEY: '', TEMPORAL_TLS_CERT: '', TEMPORAL_TLS_KEY: '' };
    expect(connectionSettings(env)).toEqual(connectionSettings({}));
    expect(connectionSettings({}, { apiKey: '' })).toMatchObject({ apiKey: undefined, tls: false });
  });

  it('returns mTLS certificate paths and turns TLS on', () => {
    expect(connectionSettings({ TEMPORAL_TLS_CERT: 'c.pem', TEMPORAL_TLS_KEY: 'k.pem' })).toMatchObject({
      tls: true,
      clientCert: { certPath: 'c.pem', keyPath: 'k.pem' },
    });
  });

  it('requires both certificate paths, or neither', () => {
    expect(() => connectionSettings({ TEMPORAL_TLS_CERT: 'c.pem' })).toThrow(NornConfigError);
    expect(() => connectionSettings({ TEMPORAL_TLS_CERT: 'c.pem', TEMPORAL_TLS_KEY: '' })).toThrow(/both/);
  });
});
