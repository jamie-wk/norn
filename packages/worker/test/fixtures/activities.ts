import { Activities, Activity, NonRetryable, Service, getCorrelationId, heartbeat, token } from '@norn/activity';

export interface Config {
  greeting: string;
}
export const Config = token<Config>('Config');

export class BlockedNameError extends Error {
  override name = 'BlockedNameError';
}

@Service({ inject: [Config] })
export class Greeter {
  constructor(private readonly config: Config) {}
  greet(name: string) {
    return `${this.config.greeting}, ${name}`;
  }
}

export const calls: string[] = [];

@Activities({ prefix: 'greet.', inject: [Greeter] })
export class GreetActivities {
  constructor(private readonly greeter: Greeter) {}

  @Activity()
  @NonRetryable([BlockedNameError])
  async hello(name: string) {
    calls.push(`hello:${name}`);
    if (name === 'blocked') throw new BlockedNameError(`${name} is blocked`);
    return this.greeter.greet(name);
  }

  @Activity() async correlation() {
    return getCorrelationId() ?? null;
  }

  @Activity({ timeout: '30s', heartbeat: '5s' }) async slow(ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      heartbeat();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    calls.push(`slow:${ms}`);
    return ms;
  }
}
