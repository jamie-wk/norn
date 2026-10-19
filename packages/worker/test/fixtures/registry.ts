// What `norn gen` writes to .norn/registry.ts, by hand.
import { fileURLToPath } from 'node:url';
import { createContainer, provide } from '@norn-ts/activity';
import { defineRegistry } from '../../src/index.ts';
import { Config, GreetActivities, Greeter } from './activities.ts';

export const disposed: string[] = [];

export const registry = defineRegistry({
  workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
  taskQueues: ['w-main', 'w-reports'],
  activities: ['greet.hello', 'greet.correlation', 'greet.slow'],
  searchAttributes: {},
  createContainer: (options = {}) =>
    createContainer({
      providers: [provide(Config, () => ({ greeting: 'Hello' }), { dispose: () => void disposed.push('Config') })],
      services: [{ cls: Greeter }],
      activities: [{ cls: GreetActivities }],
      ...options,
    }),
});
