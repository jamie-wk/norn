import { Service } from '@norn/activity';
import { Db } from './tokens.js';

/** Stock levels, one instance per activity execution. */
@Service({ scope: 'activity' })
export class InventoryService {
  constructor(private readonly db: Db) {}

  async take(sku: string): Promise<number> {
    const left = ((await this.db.get(`stock:${sku}`)) ?? 10) - 1;
    await this.db.set(`stock:${sku}`, left);
    return left;
  }
}
