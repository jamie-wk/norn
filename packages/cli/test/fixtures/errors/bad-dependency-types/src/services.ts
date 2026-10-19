import { Service } from '@norn/activity';
import type { Missing } from './missing.js';
import { NotExported } from './other.js';

interface Repo<T> {
  find(id: string): T;
}

@Service()
export class Everything {
  constructor(
    readonly name: string,
    readonly either: Date | number,
    readonly repo: Repo<string>,
    readonly missing: Missing,
    readonly unknown: Unknown,
    readonly other: NotExported,
    ..._rest: unknown[]
  ) {}
}
