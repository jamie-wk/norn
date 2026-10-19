import { fileURLToPath } from 'node:url';
import { createContainer } from '@norn/activity';
import { defineRegistry } from '@norn/worker';
import { Mailer, NotifyActivities } from './activities.ts';

export const registry = defineRegistry({
  workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
  taskQueues: ['testing-q'],
  activities: ['notify.email', 'notify.audit'],
  searchAttributes: {},
  createContainer: (options = {}) => createContainer({ services: [{ cls: Mailer }], activities: [{ cls: NotifyActivities }], ...options }),
});
