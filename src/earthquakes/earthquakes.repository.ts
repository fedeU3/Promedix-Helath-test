import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { Earthquake } from '../usgs/usgs.parser';

export interface EarthquakeRow {
  id: string;
  magnitude: number | null;
  place: string | null;
  occurredAt: Date;
  longitude: number;
  latitude: number;
  depthKm: number | null;
  url: string | null;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS earthquakes (
    id           text PRIMARY KEY,
    magnitude    double precision,
    place        text,
    occurred_at  timestamptz NOT NULL,
    updated_at   timestamptz NOT NULL,
    longitude    double precision NOT NULL,
    latitude     double precision NOT NULL,
    depth_km     double precision,
    url          text,
    raw          jsonb NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS earthquakes_occurred_at_idx ON earthquakes (occurred_at);
`;

// The WHERE clause ensures that only the update happens when the new data is actually newer than what we already have.
const UPSERT_SQL = `
  INSERT INTO earthquakes
    (id, magnitude, place, occurred_at, updated_at, longitude, latitude, depth_km, url, raw)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  ON CONFLICT (id) DO UPDATE SET
    magnitude   = excluded.magnitude,
    place       = excluded.place,
    occurred_at = excluded.occurred_at,
    updated_at  = excluded.updated_at,
    longitude   = excluded.longitude,
    latitude    = excluded.latitude,
    depth_km    = excluded.depth_km,
    url         = excluded.url,
    raw         = excluded.raw
  WHERE excluded.updated_at > earthquakes.updated_at
`;

@Injectable()
export class EarthquakesRepository {
  private schemaReady = false;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) { }

  /** Idempotent. Called at the start of each poll until it succeeds once. */
  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    await this.pool.query(SCHEMA_SQL);
    this.schemaReady = true;
  }

  /**
   * Inserts new events and applies newer revisions of known ones.
   * Returns how many rows were actually inserted or changed.
   */
  async upsertMany(events: Earthquake[]): Promise<number> {
    const client = await this.pool.connect();
    let discardClient = false;
    try {
      // Use a transaction so that either all events are inserted/updated or none are. 
      // This is important because the feed is a snapshot of the current state, and 
      // if we only partially update the database, it will be inconsistent with the feed.
      await client.query('BEGIN');
      let changed = 0;
      for (const e of events) {
        // One row at a time instead of a bulk insert: a multi-row INSERT ... ON CONFLICT
        // fails if the same id appears twice in one payload.
        const result = await client.query(UPSERT_SQL, [
          e.id,
          e.magnitude,
          e.place,
          e.occurredAt,
          e.updatedAt,
          e.longitude,
          e.latitude,
          e.depthKm,
          e.url,
          JSON.stringify(e.raw),
        ]);
        // result.rowCount is 1 if a new row was inserted, 0 if an existing row was updated or unchanged.
        changed += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
      return changed;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discardClient = true;
      }
      throw err;
    } finally {
      // Only discard the connection if ROLLBACK itself failed; a cleanly rolled-back
      // connection is fine to reuse.
      client.release(discardClient);
    }
  }

  async findLargest(hours: number, limit: number): Promise<EarthquakeRow[]> {
    const { rows } = await this.pool.query<EarthquakeRow>(
      `SELECT id, magnitude, place, occurred_at AS "occurredAt",
              longitude, latitude, depth_km AS "depthKm", url
         FROM earthquakes
        WHERE occurred_at >= now() - make_interval(hours => $1)
          AND magnitude IS NOT NULL
        ORDER BY magnitude DESC, occurred_at DESC
        LIMIT $2`,
      [hours, limit],
    );
    return rows;
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
