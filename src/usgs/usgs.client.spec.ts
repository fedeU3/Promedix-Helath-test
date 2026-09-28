import { FakeUpstream } from '../testing/fake-upstream';
import { feature, featureCollection } from '../testing/fixtures';
import { FeedError, FeedErrorKind } from './feed-error';
import { parseRetryAfter, UsgsClient } from './usgs.client';

describe('UsgsClient', () => {
  const upstream = new FakeUpstream();
  const client = new UsgsClient(300, 1024);

  beforeAll(() => upstream.start());
  afterAll(() => upstream.stop());

  async function expectFeedError(kind: FeedErrorKind): Promise<FeedError> {
    const err = await client.fetchJson(upstream.baseUrl).catch((e) => e);
    expect(err).toBeInstanceOf(FeedError);
    expect(err.kind).toBe(kind);
    return err;
  }

  it('returns parsed JSON on a 200', async () => {
    const payload = featureCollection([feature('us1')]);
    upstream.respondJson(payload);
    await expect(client.fetchJson(upstream.baseUrl)).resolves.toEqual(payload);
  });

  it('fails on a 500', async () => {
    upstream.respond(500, 'Internal Server Error');
    await expectFeedError('http_status');
  });

  it('fails on a 429 and passes Retry-After through', async () => {
    upstream.respond(429, '', { 'retry-after': '120' });
    const err = await expectFeedError('http_status');
    expect(err.retryAfterMs).toBe(120_000);
  });

  it('fails on an HTML error page served as 200', async () => {
    upstream.respond(200, '<html><body>502 Bad Gateway</body></html>');
    await expectFeedError('invalid_json');
  });

  it('fails on truncated JSON', async () => {
    upstream.respond(200, '{"type":"FeatureCollection","features":[{"id":');
    await expectFeedError('invalid_json');
  });

  it('fails on an empty body', async () => {
    upstream.respond(200, '');
    await expectFeedError('invalid_json');
  });

  it('times out when upstream never answers', async () => {
    upstream.hang();
    await expectFeedError('timeout');
  });

  it('times out when upstream stalls halfway through the body', async () => {
    upstream.stallMidBody();
    await expectFeedError('timeout');
  });

  it('rejects a body larger than the cap', async () => {
    upstream.respond(200, JSON.stringify({ junk: 'x'.repeat(5000) }));
    await expectFeedError('too_large');
  });

  it('fails when nothing is listening', async () => {
    const err = await client
      .fetchJson('http://127.0.0.1:1/feed')
      .catch((e) => e);
    expect(err).toBeInstanceOf(FeedError);
    expect(err.kind).toBe('network');
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds', () => expect(parseRetryAfter('30')).toBe(30_000));
  it('ignores missing or garbage values', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
  it('reads an HTTP date', () => {
    const inOneMinute = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfter(inOneMinute)!;
    expect(ms).toBeGreaterThan(55_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });
});
