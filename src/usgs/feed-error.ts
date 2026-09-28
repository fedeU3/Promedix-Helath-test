export type FeedErrorKind =
  | 'timeout'
  | 'network'
  | 'http_status'
  | 'too_large'
  | 'invalid_json'
  | 'invalid_shape';

/** Any reason a poll of the upstream feed produced nothing we can store. */
export class FeedError extends Error {
  constructor(
    readonly kind: FeedErrorKind,
    message: string,
    /** From a Retry-After header, if upstream sent one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'FeedError';
  }
}
