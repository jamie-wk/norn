import { describe, expect, it } from 'vitest';
import { NornConfigError } from '../../src/core/index.ts';
import { resolveWorkerConfig } from '../../src/worker/config.ts';

describe('resolveWorkerConfig', () => {
  it('defaults to a local server, treating empty variables as unset', () => {
    const config = resolveWorkerConfig({}, { TEMPORAL_ADDRESS: '', TEMPORAL_NAMESPACE: '', TEMPORAL_API_KEY: '' });
    expect(config).toEqual({ address: 'localhost:7233', namespace: 'default', apiKey: undefined, tls: false, shutdownGraceTime: '30000ms', handleSignals: true });
  });

  it('reads TEMPORAL_* variables; an API key turns TLS on', () => {
    const config = resolveWorkerConfig({}, { TEMPORAL_ADDRESS: 'temporal:7233', TEMPORAL_NAMESPACE: 'prod', TEMPORAL_API_KEY: 'secret' });
    expect(config).toMatchObject({ address: 'temporal:7233', namespace: 'prod', apiKey: 'secret', tls: true });
    expect(resolveWorkerConfig({}, { TEMPORAL_TLS: 'true' }).tls).toBe(true);
  });

  it('prefers options over the environment', () => {
    const config = resolveWorkerConfig({ address: 'x:1', namespace: 'n', tls: false, shutdownGraceTime: '5s' }, { TEMPORAL_ADDRESS: 'y:2', TEMPORAL_API_KEY: 'k' });
    expect(config).toMatchObject({ address: 'x:1', namespace: 'n', tls: false, shutdownGraceTime: '5000ms' });
  });

  it('rejects a bad grace time', () => {
    expect(() => resolveWorkerConfig({ shutdownGraceTime: 'soon' as never }, {})).toThrow(NornConfigError);
  });
});
