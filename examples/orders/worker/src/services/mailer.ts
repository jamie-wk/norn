import { Service, token } from '@norn/activity';
import { HttpClient } from './http.ts';

export interface Mailer {
  send(message: { to: string; template: string; data: Record<string, unknown> }): Promise<{ messageId: string }>;
}
export const Mailer = token<Mailer>('Mailer');

/** Sends email through the provider's mail API. */
@Service({ provides: Mailer })
export class HttpMailer implements Mailer {
  constructor(private readonly http: HttpClient) {}
  send(message: { to: string; template: string; data: Record<string, unknown> }) {
    return this.http.post<{ messageId: string }>('/emails', message);
  }
}
