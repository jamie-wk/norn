import { heartbeat } from '@temporalio/activity';

export class BlockedNameError extends Error {
  override name = 'BlockedNameError';
}

export const calls: string[] = [];

/** Plain activities: the worker registers each method as `greet.<method>`. */
export class GreetActivities {
  constructor(private readonly greeting: string) {}

  async hello(name: string) {
    calls.push(`hello:${name}`);
    if (name === 'blocked') throw new BlockedNameError(`${name} is blocked`);
    return `${this.greeting}, ${name}`;
  }

  async slow(ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      heartbeat();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    calls.push(`slow:${ms}`);
    return ms;
  }
}
