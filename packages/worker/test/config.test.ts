import { describe, expect, it } from 'vitest';
import { NornConfigError } from '@norn/core';
import { resolveWorkerConfig } from '../src/index.ts';
import { registry } from './fixtures/registry.ts';

describe('resolveWorkerConfig', () => {
  it('treats empty environment variables as unset, like the CLI', () => {
    const empty = { TEMPORAL_ADDRESS: '', TEMPORAL_NAMESPACE: '', TEMPORAL_API_KEY: '', NORN_TASK_QUEUES: '', NORN_HEALTH_PORT: '', NORN_SHUTDOWN_GRACE: '' };
    const config = resolveWorkerConfig({ registry }, empty);
    expect(config).toMatchObject({ address: 'localhost:7233', namespace: 'default', taskQueues: registry.taskQueues, healthPort: undefined, tls: false });
  });

  it('enables TLS with TEMPORAL_TLS=true, like the CLI', () => {
    expect(resolveWorkerConfig({ registry }, { TEMPORAL_TLS: 'true' }).tls).toBe(true);
  });

  it('defaults to every task queue in the registry', () => {
    const config = resolveWorkerConfig({ registry }, {});
    expect(config.taskQueues).toEqual(['w-main', 'w-reports']);
    expect(config.address).toBe('localhost:7233');
    expect(config.namespace).toBe('default');
    expect(config.deployment).toBeUndefined();
    expect(config.healthPort).toBeUndefined();
    expect(config.shutdownGraceTime).toBe('30000ms');
    expect(config.handleSignals).toBe(true);
  });

  it('reads connection and queue settings from the environment', () => {
    const config = resolveWorkerConfig(
      { registry },
      {
        TEMPORAL_ADDRESS: 'temporal:7233',
        TEMPORAL_NAMESPACE: 'prod',
        TEMPORAL_API_KEY: 'secret',
        NORN_TASK_QUEUES: 'w-reports',
        NORN_HEALTH_PORT: '8080',
        NORN_SHUTDOWN_GRACE: '2m',
      },
    );
    expect(config).toMatchObject({
      address: 'temporal:7233',
      namespace: 'prod',
      apiKey: 'secret',
      tls: true,
      taskQueues: ['w-reports'],
      healthPort: 8080,
      shutdownGraceTime: '120000ms',
    });
  });

  it('prefers explicit options over the environment', () => {
    const config = resolveWorkerConfig(
      { registry, taskQueues: ['w-main'], address: 'x:1', namespace: 'n', health: { port: 9 }, shutdownGraceTime: '5s' },
      { NORN_TASK_QUEUES: 'w-reports', TEMPORAL_ADDRESS: 'y:2', NORN_HEALTH_PORT: '8080' },
    );
    expect(config).toMatchObject({ taskQueues: ['w-main'], address: 'x:1', namespace: 'n', healthPort: 9, shutdownGraceTime: '5000ms' });
  });

  it('turns on worker deployment versioning when a deployment and build ID are set', () => {
    const config = resolveWorkerConfig({ registry }, { NORN_DEPLOYMENT_NAME: 'orders', NORN_BUILD_ID: 'abc123' });
    expect(config.deployment).toEqual({
      version: { deploymentName: 'orders', buildId: 'abc123' },
      useWorkerVersioning: true,
      defaultVersioningBehavior: 'AUTO_UPGRADE',
    });
    const pinned = resolveWorkerConfig({ registry, versioning: { deploymentName: 'd', buildId: 'b', defaultBehavior: 'pinned' } }, {});
    expect(pinned.deployment?.defaultVersioningBehavior).toBe('PINNED');
  });

  it.each([
    [{ NORN_DEPLOYMENT_NAME: 'orders' }, /NORN_BUILD_ID/],
    [{ NORN_BUILD_ID: 'abc' }, /NORN_DEPLOYMENT_NAME/],
    [{ NORN_TASK_QUEUES: 'nope' }, /Task queue nope is not used by any workflow/],
    [{ NORN_HEALTH_PORT: 'eighty' }, /NORN_HEALTH_PORT/],
    [{ NORN_HEALTH_PORT: '70000' }, /NORN_HEALTH_PORT/],
    [{ NORN_SHUTDOWN_GRACE: 'soon' }, /NORN_SHUTDOWN_GRACE/],
  ])('rejects invalid settings %j', (env, message) => {
    expect(() => resolveWorkerConfig({ registry }, env)).toThrow(NornConfigError);
    expect(() => resolveWorkerConfig({ registry }, env)).toThrow(message);
  });

  it('rejects an empty task queue list and invalid registries', () => {
    expect(() => resolveWorkerConfig({ registry, taskQueues: [] }, {})).toThrow(/at least one task queue/);
    expect(() => resolveWorkerConfig({ registry: {} as never }, {})).toThrow(/registry/);
  });

  it('allows extra task queues for activity-only workers when flagged', () => {
    const config = resolveWorkerConfig({ registry, taskQueues: ['activities-only'], allowUnknownTaskQueues: true }, {});
    expect(config.taskQueues).toEqual(['activities-only']);
  });
});
