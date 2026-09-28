import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from './app.module';
import { APP_CONFIG } from './config';
import { PG_POOL } from './database/database.module';
import { EarthquakesRepository } from './earthquakes/earthquakes.repository';
import { PollerService } from './poller/poller.service';
import { feature } from './testing/fixtures';
import { clearTable, setUpTestDb, TEST_DATABASE_URL } from './testing/test-db';
import { parseFeed } from './usgs/usgs.parser';

const HOUR = 60 * 60_000;

describe('HTTP API', () => {
  let app: INestApplication;
  let pool: Pool;
  const pollerStatus = {
    lastAttemptAt: null as Date | null,
    lastSuccessAt: null as Date | null,
    lastError: null,
    consecutiveFailures: 0,
    lastResult: null,
  };

  beforeAll(async () => {
    ({ pool } = await setUpTestDb());
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue({ databaseUrl: TEST_DATABASE_URL, pollIntervalMs: 60_000 })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      // The real poller would call USGS from inside the tests.
      .overrideProvider(PollerService)
      .useValue({ status: pollerStatus })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close()); // also ends the pool via DatabaseModule

  beforeEach(() => clearTable(pool));

  async function seed(...features: ReturnType<typeof feature>[]) {
    const { events } = parseFeed({ type: 'FeatureCollection', features });
    await new EarthquakesRepository(pool).upsertMany(events);
  }

  describe('GET /earthquakes', () => {
    it('returns the largest quakes of the last 24 hours, biggest first', async () => {
      const now = Date.now();
      await seed(
        feature('small', { mag: 2.1, time: now - HOUR }),
        feature('big', { mag: 6.3, time: now - 2 * HOUR }),
        feature('medium', { mag: 4.0, time: now - 3 * HOUR }),
        feature('too-old', { mag: 7.5, time: now - 30 * HOUR }),
        feature('no-mag', { mag: null, time: now - HOUR }),
      );

      const res = await request(app.getHttpServer())
        .get('/earthquakes')
        .expect(200);

      expect(res.body.earthquakes.map((e: { id: string }) => e.id)).toEqual([
        'big',
        'medium',
        'small',
      ]);
    });

    it('respects limit and hours', async () => {
      const now = Date.now();
      await seed(
        feature('a', { mag: 5, time: now - HOUR }),
        feature('b', { mag: 4, time: now - HOUR }),
        feature('c', { mag: 6, time: now - 5 * HOUR }),
      );

      const res = await request(app.getHttpServer())
        .get('/earthquakes?hours=2&limit=1')
        .expect(200);

      expect(res.body.earthquakes.map((e: { id: string }) => e.id)).toEqual([
        'a',
      ]);
    });

    it.each(['hours=0', 'hours=abc', 'limit=1000', 'limit=1.5'])(
      'rejects %s with a 400',
      (query) =>
        request(app.getHttpServer()).get(`/earthquakes?${query}`).expect(400),
    );
  });

  describe('GET /health', () => {
    it('is 503 before the first successful poll', async () => {
      pollerStatus.lastSuccessAt = null;
      const res = await request(app.getHttpServer()).get('/health').expect(503);
      expect(res.body).toMatchObject({ database: 'up', stale: true });
    });

    it('is 200 when the last poll is recent', async () => {
      pollerStatus.lastSuccessAt = new Date();
      await request(app.getHttpServer()).get('/health').expect(200);
    });

    it('is 503 when data is stale', async () => {
      pollerStatus.lastSuccessAt = new Date(Date.now() - HOUR);
      const res = await request(app.getHttpServer()).get('/health').expect(503);
      expect(res.body.stale).toBe(true);
    });
  });
});
