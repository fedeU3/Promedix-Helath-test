import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

export interface AppConfig {
  port: number;
  databaseUrl: string;
  feedUrl: string;
  /** Wider feed used when we may have missed events (first run, long outage). */
  backfillFeedUrl: string;
  pollIntervalMs: number;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

const USGS_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required (see .env.example)');
  }
  return {
    port: toInt(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL,
    feedUrl: env.FEED_URL || `${USGS_BASE}/all_hour.geojson`,
    backfillFeedUrl: env.BACKFILL_FEED_URL || `${USGS_BASE}/all_day.geojson`,
    pollIntervalMs: toInt(env.POLL_INTERVAL_MS, 5 * 60_000),
  };
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Expected a positive integer, got "${value}"`);
  }
  return n;
}

// ConfigModule.forRoot() loads .env into process.env synchronously, so the
// factory below sees those values. Real environment variables take precedence.
@Global()
@Module({
  imports: [ConfigModule.forRoot()],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig(process.env) },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
