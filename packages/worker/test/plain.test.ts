import { describe, expect, it } from 'vitest';
import { NornConfigError } from '@norn-ts/core';
import { activityFunctions } from '../src/plain.ts';

class Base {
  constructor(protected readonly prefix: string) {}
  async greet(name: string) {
    return `${this.prefix} ${name}`;
  }
}
class Greeter extends Base {
  override async greet(name: string) {
    return `${await super.greet(name)}!`;
  }
  async wave() {
    return this.prefix;
  }
}

describe('activityFunctions', () => {
  it('registers every method as <namespace>.<method>, bound to its instance, subclass first', async () => {
    const fns = activityFunctions({ greet: new Greeter('hi'), plain: { ping: async () => 'pong' } });
    expect(Object.keys(fns).sort()).toEqual(['greet.greet', 'greet.wave', 'plain.ping']);
    expect(await fns['greet.greet']!('ann')).toBe('hi ann!');
    expect(await fns['greet.wave']!()).toBe('hi');
  });

  it('rejects a namespace that is not an object', () => {
    expect(() => activityFunctions({ bad: 'x' as never })).toThrow(NornConfigError);
  });
});
