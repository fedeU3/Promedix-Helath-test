// Most failures are short blips, so the first retry comes quickly (30s). The cap keeps
// us from hammering an API that is really down, while still checking every 15 minutes.
export const FIRST_RETRY_MS = 30_000;
export const MAX_RETRY_MS = 15 * 60_000;

/**
 * How long to wait before the next poll.
 * `random` is injectable so tests can pin the jitter.
 */
export function nextDelayMs(
  consecutiveFailures: number,
  intervalMs: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (consecutiveFailures === 0) return intervalMs;

  const exponential = Math.min(
    FIRST_RETRY_MS * 2 ** (consecutiveFailures - 1),
    MAX_RETRY_MS,
  );
  // Jitter (±20%) avoids retrying in lockstep with other clients that failed at the same
  // moment. With a single instance it matters little, but it costs nothing.
  const jittered = exponential * (0.8 + random() * 0.4);
  const delay = Math.max(jittered, retryAfterMs ?? 0);
  return Math.round(Math.min(delay, MAX_RETRY_MS));
}
