import { Service, cancellationSignal, getCorrelationId } from '@norn-ts/activity';
import { AppConfig } from './config.ts';

/** A non-2xx response. `status` lets the container treat 4xx as final and 5xx as retryable. */
export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the provider with timeouts, cancellation and the request's correlation ID. */
@Service()
export class HttpClient {
  constructor(private readonly config: AppConfig) {}

  async post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    const signals = [AbortSignal.timeout(this.config.httpTimeoutMs)];
    try {
      signals.push(cancellationSignal());
    } catch {
      // Not inside an activity (e.g. a unit test); timeouts still apply.
    }
    const correlationId = getCorrelationId();
    const res = await fetch(new URL(path, this.config.providerUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}), ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) throw new HttpError(res.status, data, `POST ${path} failed with ${res.status}`);
    return data as T;
  }
}
