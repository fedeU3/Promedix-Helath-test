import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG } from '../config';
import type { AppConfig } from '../config';
import { EarthquakesRepository } from '../earthquakes/earthquakes.repository';
import { FeedError } from '../usgs/feed-error';
import { UsgsClient } from '../usgs/usgs.client';
import { parseFeed } from '../usgs/usgs.parser';
import { nextDelayMs } from './backoff';

// all_hour only covers the last 60 minutes. After 45 minutes without a success, the next
// attempt can be up to 15 minutes away (max backoff), which lands right at that 60-minute
// edge. So from 45 minutes on we fetch all_day instead, which covers 24 hours.
export const BACKFILL_AFTER_MS = 45 * 60_000;

export interface PollStatus {
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastResult: {
    feedUrl: string;
    received: number;
    skipped: number;
    changed: number;
  } | null;
}

@Injectable()
export class PollerService
  implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PollerService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private retryAfterMs: number | undefined;

  readonly status: PollStatus = {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    lastResult: null,
  };

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly client: UsgsClient,
    private readonly repository: EarthquakesRepository,
  ) { }

  // Schedule the first poll to run immediately after the app is bootstrapped. 
  // Subsequent polls are scheduled after each one finishes.
  onApplicationBootstrap() {
    this.scheduleNext(0);
  }

  // Wait for any in-flight poll to finish before shutting down.
  async beforeApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }

  // Schedule the next poll, possibly with a delay.
  private scheduleNext(delayMs: number) {
    if (this.stopped) return;
    // setTimeout instead of setInterval: the next poll is scheduled only after this one
    // finishes, so polls never overlap, and the delay can grow after failures (backoff).
    this.timer = setTimeout(() => {
      this.inFlight = this.runCycle().finally(() => {
        this.inFlight = null;
        const delay = nextDelayMs(
          this.status.consecutiveFailures,
          this.config.pollIntervalMs,
          this.retryAfterMs,
        );
        this.scheduleNext(delay);
      });
    }, delayMs);
  }

  /** One poll. Never throws; the outcome is recorded in `status`. */
  async runCycle(now = new Date()): Promise<void> {
    const feedUrl = this.needsBackfill(now)
      ? this.config.backfillFeedUrl
      : this.config.feedUrl;
    this.status.lastAttemptAt = now;
    // Calls to this.client.fetchJson may throw FeedError.
    try {
      // Ensure the database schema is ready before we try to insert anything.
      await this.repository.ensureSchema();
      // Fetch the feed and parse it. If the feed is invalid, this will throw a FeedError.
      const payload = await this.client.fetchJson(feedUrl);
      // Parse the feed and validate each feature. If all features fail validation, throw a
      // FeedError.
      const { events, skipped } = parseFeed(payload);
      // Every feature failing validation most likely means USGS changed its format. Count it
      // as a failure so /health reports it and backoff kicks in; we keep polling either way.
      if (events.length === 0 && skipped > 0) {
        throw new FeedError(
          'invalid_shape',
          `All ${skipped} features failed validation`,
        );
      }
      // Insert new or updated events into the database.
      const changed = await this.repository.upsertMany(events);

      this.status.lastSuccessAt = now;
      this.status.lastError = null;
      this.status.consecutiveFailures = 0;
      this.status.lastResult = {
        feedUrl,
        received: events.length,
        skipped,
        changed,
      };
      this.retryAfterMs = undefined;
      this.logger.log(
        `Polled ${feedUrl}: ${events.length} events, ${changed} new/updated, ${skipped} skipped`,
      );
    } catch (err) {
      // Record the failure, but don't throw; we want to keep polling.
      this.status.consecutiveFailures++;
      this.status.lastError = err instanceof Error ? err.message : String(err);
      this.retryAfterMs =
        err instanceof FeedError ? err.retryAfterMs : undefined;
      this.logger.warn(
        `Poll failed (${this.status.consecutiveFailures} in a row): ${this.status.lastError}`,
      );
    }
  }

  // Return true if the last successful poll was long enough ago that we should fetch the
  // backfill feed instead of the regular feed. This is a heuristic to avoid missing events
  // when the poller has been down for a while.
  private needsBackfill(now: Date): boolean {
    const last = this.status.lastSuccessAt;
    return !last || now.getTime() - last.getTime() > BACKFILL_AFTER_MS;
  }
}
