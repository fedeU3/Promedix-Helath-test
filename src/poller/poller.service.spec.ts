import { Pool } from 'pg';
import { AppConfig } from '../config';
import { createPool } from '../database/database.module';
import { EarthquakesRepository } from '../earthquakes/earthquakes.repository';
import { FakeUpstream } from '../testing/fake-upstream';
import { feature, featureCollection } from '../testing/fixtures';
import { clearTable, countRows, setUpTestDb } from '../testing/test-db';
import { UsgsClient } from '../usgs/usgs.client';
import { BACKFILL_AFTER_MS, PollerService } from './poller.service';

describe('PollerService', () => {
  const upstream = new FakeUpstream();
  let pool: Pool;
  let repository: EarthquakesRepository;
  let poller: PollerService;
  let config: AppConfig;

  beforeAll(async () => {
    await upstream.start();
    ({ pool, repository } = await setUpTestDb());
  });

  afterAll(async () => {
    await upstream.stop();
    await pool.end();
  });

  beforeEach(async () => {
    await clearTable(pool);
    upstream.requestedPaths.length = 0;
    config = {
      port: 0,
      databaseUrl: 'unused',
      feedUrl: `${upstream.baseUrl}/hour`,
      backfillFeedUrl: `${upstream.baseUrl}/day`,
      pollIntervalMs: 60_000,
    };
    poller = new PollerService(config, new UsgsClient(300), repository);
  });

  async function magnitudeOf(id: string): Promise<number | null> {
    const { rows } = await pool.query(
      'SELECT magnitude FROM earthquakes WHERE id = $1',
      [id],
    );
    return rows[0]?.magnitude ?? null;
  }

  describe('idempotency', () => {
    it('stores each event once, however many times it is polled', async () => {
      upstream.respondJson(featureCollection([feature('a'), feature('b')]));

      await poller.runCycle();
      await poller.runCycle();
      await poller.runCycle();

      expect(await countRows(pool)).toBe(2);
      expect(poller.status.lastResult?.changed).toBe(0);
    });

    it('applies a newer revision of an event', async () => {
      upstream.respondJson(
        featureCollection([feature('a', { mag: 4.1, updated: 1000 })]),
      );
      await poller.runCycle();

      upstream.respondJson(
        featureCollection([feature('a', { mag: 4.6, updated: 2000 })]),
      );
      await poller.runCycle();

      expect(await countRows(pool)).toBe(1);
      expect(await magnitudeOf('a')).toBe(4.6);
    });

    it('ignores an older revision arriving late', async () => {
      upstream.respondJson(
        featureCollection([feature('a', { mag: 4.6, updated: 2000 })]),
      );
      await poller.runCycle();

      upstream.respondJson(
        featureCollection([feature('a', { mag: 4.1, updated: 1000 })]),
      );
      await poller.runCycle();

      expect(await magnitudeOf('a')).toBe(4.6);
    });

    it('does not fail when the same event appears twice in one payload', async () => {
      upstream.respondJson(
        featureCollection([
          feature('a', { mag: 3, updated: 1000 }),
          feature('a', { mag: 3.2, updated: 2000 }),
        ]),
      );
      await poller.runCycle();

      expect(poller.status.consecutiveFailures).toBe(0);
      expect(await magnitudeOf('a')).toBe(3.2);
    });
  });

  describe('surviving upstream failure', () => {
    const badResponses: Array<[string, () => void]> = [
      ['a 500', () => upstream.respond(500, 'oops')],
      ['HTML garbage', () => upstream.respond(200, '<html>Bad Gateway</html>')],
      ['truncated JSON', () => upstream.respond(200, '{"type":"Feature')],
      ['JSON of the wrong shape', () => upstream.respondJson({ hello: 1 })],
      ['a timeout', () => upstream.hang()],
    ];

    it.each(badResponses)(
      'keeps existing data on %s, then recovers on the next good cycle',
      async (_label, breakUpstream) => {
        upstream.respondJson(featureCollection([feature('a'), feature('b')]));
        await poller.runCycle();
        expect(await countRows(pool)).toBe(2);

        breakUpstream();
        await expect(poller.runCycle()).resolves.toBeUndefined();
        expect(await countRows(pool)).toBe(2);
        expect(poller.status.consecutiveFailures).toBe(1);
        expect(poller.status.lastError).toBeTruthy();

        upstream.respondJson(
          featureCollection([feature('a'), feature('b'), feature('c')]),
        );
        await poller.runCycle();
        expect(await countRows(pool)).toBe(3);
        expect(poller.status.consecutiveFailures).toBe(0);
        expect(poller.status.lastError).toBeNull();
      },
    );

    it('counts a feed where every feature is invalid as a failure', async () => {
      upstream.respondJson(featureCollection([{ junk: true }, 42]));
      await poller.runCycle();

      expect(poller.status.consecutiveFailures).toBe(1);
      expect(poller.status.lastError).toMatch(/failed validation/);
    });

    it('stores the valid features when only some are broken', async () => {
      upstream.respondJson(featureCollection([feature('a'), { junk: true }]));
      await poller.runCycle();

      expect(await countRows(pool)).toBe(1);
      expect(poller.status.lastResult).toMatchObject({
        received: 1,
        skipped: 1,
      });
    });
  });

  describe('surviving database failure', () => {
    it('records the failure instead of throwing when Postgres is down', async () => {
      const deadPool = createPool('postgres://quakes:quakes@127.0.0.1:1/x');
      const deadPoller = new PollerService(
        config,
        new UsgsClient(300),
        new EarthquakesRepository(deadPool),
      );
      upstream.respondJson(featureCollection([feature('a')]));

      await expect(deadPoller.runCycle()).resolves.toBeUndefined();
      expect(deadPoller.status.consecutiveFailures).toBe(1);
      await deadPool.end();
    });
  });

  describe('backfill', () => {
    it('uses the day feed on the first cycle, then the hour feed', async () => {
      upstream.respondJson(featureCollection([feature('a')]));

      await poller.runCycle();
      await poller.runCycle();

      expect(upstream.requestedPaths).toEqual(['/day', '/hour']);
    });

    it('goes back to the day feed after a long outage', async () => {
      const start = new Date('2026-01-01T00:00:00Z');
      upstream.respondJson(featureCollection([feature('a')]));
      await poller.runCycle(start);

      upstream.respond(503, 'down');
      await poller.runCycle(new Date(start.getTime() + 10 * 60_000));

      upstream.respondJson(featureCollection([feature('a')]));
      await poller.runCycle(new Date(start.getTime() + BACKFILL_AFTER_MS + 1));

      expect(upstream.requestedPaths).toEqual(['/day', '/hour', '/day']);
    });
  });
});
