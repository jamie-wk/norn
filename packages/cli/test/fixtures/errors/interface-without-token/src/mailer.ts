export interface Mailer {
  send(): Promise<number>;
}
