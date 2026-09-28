import { FIRST_RETRY_MS, MAX_RETRY_MS, nextDelayMs } from './backoff';

const INTERVAL = 5 * 60_000;
const noJitter = () => 0.5; // 0.8 + 0.5 * 0.4 = 1.0x

describe('nextDelayMs', () => {
  it('uses the normal interval when the last poll succeeded', () => {
    expect(nextDelayMs(0, INTERVAL, undefined, noJitter)).toBe(INTERVAL);
  });

  it('doubles the wait after each consecutive failure', () => {
    const delays = [1, 2, 3, 4].map((n) =>
      nextDelayMs(n, INTERVAL, undefined, noJitter),
    );
    expect(delays).toEqual([
      FIRST_RETRY_MS,
      FIRST_RETRY_MS * 2,
      FIRST_RETRY_MS * 4,
      FIRST_RETRY_MS * 8,
    ]);
  });

  it('never waits longer than the cap', () => {
    expect(nextDelayMs(50, INTERVAL, undefined, () => 1)).toBe(MAX_RETRY_MS);
  });

  it('keeps jitter within ±20%', () => {
    expect(nextDelayMs(1, INTERVAL, undefined, () => 0)).toBe(
      FIRST_RETRY_MS * 0.8,
    );
    expect(nextDelayMs(1, INTERVAL, undefined, () => 1)).toBe(
      FIRST_RETRY_MS * 1.2,
    );
  });

  it('honors Retry-After when it asks for longer, up to the cap', () => {
    expect(nextDelayMs(1, INTERVAL, 120_000, noJitter)).toBe(120_000);
    expect(nextDelayMs(1, INTERVAL, 24 * 60 * 60_000, noJitter)).toBe(
      MAX_RETRY_MS,
    );
  });
});
