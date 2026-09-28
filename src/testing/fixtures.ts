const HOUR = 60 * 60_000;

interface FeatureOptions {
  mag?: number | null;
  time?: number;
  updated?: number;
  place?: string;
}

/** A feature shaped like the real USGS summary feed. */
export function feature(id: string, options: FeatureOptions = {}) {
  const time = options.time ?? Date.now() - HOUR;
  return {
    type: 'Feature',
    id,
    properties: {
      mag: options.mag === undefined ? 2.5 : options.mag,
      place: options.place ?? `Somewhere near ${id}`,
      time,
      updated: options.updated ?? time + 60_000,
      url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
      type: 'earthquake',
    },
    geometry: { type: 'Point', coordinates: [-122.5, 38.1, 7.2] },
  };
}

export function featureCollection(features: unknown[]) {
  return {
    type: 'FeatureCollection',
    metadata: { generated: Date.now(), status: 200, count: features.length },
    features,
  };
}
