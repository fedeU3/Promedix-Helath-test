import { Pool } from 'pg';
import { createPool } from '../database/database.module';
import { EarthquakesRepository } from '../earthquakes/earthquakes.repository';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://quakes:quakes@localhost:5432/quakes_test';

/** Connects to the test database and gives each test an empty table. */
export async function setUpTestDb(): Promise<{
  pool: Pool;
  repository: EarthquakesRepository;
}> {
  const pool = createPool(TEST_DATABASE_URL);
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end();
    throw new Error(
      `Test database unreachable at ${TEST_DATABASE_URL}. ` +
        `Start it with "docker compose up -d db". (${(err as Error).message})`,
    );
  }
  const repository = new EarthquakesRepository(pool);
  await repository.ensureSchema();
  return { pool, repository };
}

export async function clearTable(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE earthquakes');
}

export async function countRows(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM earthquakes',
  );
  return rows[0].n;
}
