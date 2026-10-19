import { Service, token } from '@norn-ts/activity';
import type { Config, Db } from './tokens.js';

export interface Transfer {
  from: string;
  cents: number;
}

export interface TransferService {
  send(transfer: Transfer): Promise<string>;
}
export const TransferService = token<TransferService>('TransferService');

@Service({ provides: TransferService })
export class BankTransferService implements TransferService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  async send(transfer: Transfer): Promise<string> {
    const count = ((await this.db.get('transfers')) ?? 0) + 1;
    await this.db.set('transfers', count);
    return `${this.config.currency}-${transfer.from}-${transfer.cents}-${count}`;
  }
}
