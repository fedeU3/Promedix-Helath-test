import { feature, featureCollection } from '../testing/fixtures';
import { FeedError } from './feed-error';
import { parseFeed } from './usgs.parser';

describe('parseFeed', () => {
  it('maps a valid feature to an Earthquake', () => {
    const f = feature('us1', { mag: 4.2, time: 1_700_000_000_000 });
    const { events, skipped } = parseFeed(featureCollection([f]));

    expect(skipped).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'us1',
      magnitude: 4.2,
      occurredAt: new Date(1_700_000_000_000),
      longitude: -122.5,
      latitude: 38.1,
      depthKm: 7.2,
    });
  });

  it('accepts a null magnitude (USGS sometimes has none yet)', () => {
    const { events } = parseFeed(
      featureCollection([feature('us1', { mag: null })]),
    );
    expect(events[0].magnitude).toBeNull();
  });

  it('accepts an empty feed', () => {
    expect(parseFeed(featureCollection([]))).toEqual({
      events: [],
      skipped: 0,
    });
  });

  it.each([
    ['null', null],
    ['a string', 'hello'],
    ['an array', []],
    ['the wrong type', { type: 'Feature', features: [] }],
    ['no features array', { type: 'FeatureCollection', features: 'oops' }],
  ])('rejects the whole payload when it is %s', (_label, payload) => {
    expect(() => parseFeed(payload)).toThrow(FeedError);
  });

  it('skips individual bad features but keeps the good ones', () => {
    const good = feature('good');
    const noId = { ...feature('x'), id: '' };
    const badTime = feature('bad-time');
    (badTime.properties as Record<string, unknown>).time = 'yesterday';
    const badMag = feature('bad-mag');
    (badMag.properties as Record<string, unknown>).mag = '4.5';
    const badCoords = feature('bad-coords');
    badCoords.geometry.coordinates = [500, 38];

    const { events, skipped } = parseFeed(
      featureCollection([good, noId, badTime, badMag, badCoords, 'junk']),
    );

    expect(events.map((e) => e.id)).toEqual(['good']);
    expect(skipped).toBe(5);
  });
});
