import { token } from '@norn/activity';

export interface Db {
  get(key: string): Promise<number | undefined>;
  set(key: string, value: number): Promise<void>;
}
export const Db = token<Db>('Db');

export interface Config {
  currency: string;
  bankUrl: string;
}
export const Config = token<Config>('Config');
