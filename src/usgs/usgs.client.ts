import { FeedError } from './feed-error';

export const FETCH_TIMEOUT_MS = 10_000;
// We never accept more than 10 MB. The feeds we use are far smaller (all_day is ~170 KB),
// so anything near this is not a real feed, and reading it could exhaust memory.
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

// Registered with a factory in AppModule: the constructor takes plain numbers
// (overridable in tests), which Nest's DI can't resolve by type.
export class UsgsClient {
  constructor(
    private readonly timeoutMs = FETCH_TIMEOUT_MS,
    private readonly maxBytes = MAX_BODY_BYTES,
  ) { }

  /** Fetches and JSON-parses the feed. Throws FeedError on any failure. */
  async fetchJson(url: string): Promise<unknown> {
    const signal = AbortSignal.timeout(this.timeoutMs);

    let response: Response;
    // The actual fetch call is wrapped in a try/catch so that network errors can be distinguished from
    // HTTP errors (which don't throw). The try/catch also ensures that the AbortSignal is checked, so
    // timeouts are reported as FeedError('timeout') instead of FeedError('network').
    try {
      response = await fetch(url, {
        signal,
        headers: { accept: 'application/geo+json, application/json' },
      });
    } catch (err) {
      throw toNetworkError(err, signal);
    }

    // fetch does not throw on a 500 or 404, so the status has to be checked by hand.
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new FeedError(
        'http_status',
        `Upstream returned HTTP ${response.status}`,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }
    // The response body is read and parsed in a separate try/catch so that network errors
    // (e.g. connection reset) can be distinguished from invalid JSON.
    let text: string;
    try {
      text = await this.readBody(response);
    } catch (err) {
      throw err instanceof FeedError ? err : toNetworkError(err, signal);
    }

    // A 200 can still carry garbage, e.g. an HTML error page from a proxy.
    try {
      return JSON.parse(text);
    } catch {
      throw new FeedError(
        'invalid_json',
        `Response is not valid JSON (starts with ${JSON.stringify(text.slice(0, 40))})`,
      );
    }
  }

  private async readBody(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new FeedError(
          'too_large',
          `Response exceeded ${this.maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

function toNetworkError(err: unknown, signal: AbortSignal): FeedError {
  // Check our own signal instead of the error's name: under Jest the abort error is not
  // an instanceof Error, so timeouts were being reported as network errors.
  if (signal.aborted) {
    return new FeedError('timeout', 'Upstream request timed out');
  }
  const cause =
    err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new FeedError('network', `Upstream unreachable: ${message}`);
}

/** Retry-After is either seconds or an HTTP date. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}
