import { FeedError } from './feed-error';

export interface Earthquake {
  /** USGS event id, e.g. "us7000abcd". */
  id: string;
  magnitude: number | null;
  place: string | null;
  occurredAt: Date;
  /** When USGS last revised this event. */
  updatedAt: Date;
  longitude: number;
  latitude: number;
  depthKm: number | null;
  url: string | null;
  raw: unknown;
}

export interface ParsedFeed {
  events: Earthquake[];
  /** Features that failed validation and were left out. */
  skipped: number;
}

export function parseFeed(payload: unknown): ParsedFeed {
  // The USGS feed is a GeoJSON FeatureCollection. Each feature is an earthquake event.
  if (!isObject(payload) || payload.type !== 'FeatureCollection') {
    // If the envelope itself is wrong, nothing inside it can be trusted: reject the whole payload.
    throw new FeedError(
      'invalid_shape',
      'Payload is not a GeoJSON FeatureCollection',
    );
  }
  if (!Array.isArray(payload.features)) {
    throw new FeedError('invalid_shape', 'Payload has no "features" array');
  }

  const events: Earthquake[] = [];
  let skipped = 0;
  // One bad quake is skipped rather than failing the whole feed, so a single broken
  // record doesn't throw away the valid ones next to it.
  for (const feature of payload.features) {
    const event = parseFeature(feature);
    if (event) events.push(event);
    // One bad quake is skipped rather than failing the whole feed, so a single broken
    // record doesn't throw away the valid ones next to it.
    else skipped++;
  }
  return { events, skipped };
}

function parseFeature(feature: unknown): Earthquake | null {
  if (
    !isObject(feature) ||
    !isObject(feature.properties) ||
    !isObject(feature.geometry)
  ) {
    return null;
  }
  const { id, properties: p, geometry } = feature;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (!isTimestamp(p.time) || !isTimestamp(p.updated)) return null;
  if (!isNumberOrNull(p.mag)) return null;

  const coords = geometry.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [longitude, latitude, depth] = coords as unknown[];
  if (
    !isNumberInRange(longitude, -180, 180) ||
    !isNumberInRange(latitude, -90, 90)
  ) {
    return null;
  }

  // Converts it into our internal Earthquake type, which is more convenient to work with than the raw USGS feature.
  return {
    id,
    magnitude: p.mag,
    place: typeof p.place === 'string' ? p.place : null,
    occurredAt: new Date(p.time),
    updatedAt: new Date(p.updated),
    longitude,
    latitude,
    depthKm: isFiniteNumber(depth) ? depth : null,
    url: typeof p.url === 'string' ? p.url : null,
    raw: feature,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isNumberInRange(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return isFiniteNumber(value) && value >= min && value <= max;
}

/** USGS times are epoch milliseconds. */
function isTimestamp(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}
