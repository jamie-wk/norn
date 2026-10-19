import { provide } from '@norn/activity';
import { Config, Db } from './services/tokens.js';

class MemoryDb implements Db {
  private readonly values = new Map<string, number>();
  async get(key: string) {
    return this.values.get(key);
  }
  async set(key: string, value: number) {
    this.values.set(key, value);
  }
}

export const providers = [
  provide(Db, () => new MemoryDb()),
  provide(Config, () => ({ currency: 'USD', bankUrl: 'https://bank.example' })),
];
