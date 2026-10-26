import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  buildHeaders,
  buildGardenSearchUrl,
  buildQueueUrl,
  buildReviewUrl,
  createFeedClient,
  edenItemUrl,
  FeedContractError,
  FeedHttpError,
  feedErrorKind,
  fetchGardenSearch,
  fetchReview,
  loadCachedReview,
  parseGardenSearch,
  parseReviewEnvelope,
  reviewPageUrl,
  saveCachedReview,
  createLatestCacheWriter,
  hasHostAccess,
  isCanonicalPinTimestamp,
  loadCachedItems,
  loadConfig,
  originPattern,
  requestHostAccess,
  safeDestinationUrl,
  safeHttpUrl,
  safeMediaUrl,
  saveCachedItems,
  saveConfig,
  type FeedConfig,
  type PinItem,
} from './feed';

const config: FeedConfig = { baseUrl: 'https://feed.test:3335', token: 'secret' };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

const item: PinItem = {
  id: 'pin-1',
  title: 'Garden pin',
  url: 'https://example.com/article',
  media: {
    kind: 'video',
    url: 'https://video.twimg.com/ext_tw_video/example/pu/vid/avc1/1280x720/clip.mp4',
    poster_url: 'https://pbs.twimg.com/ext_tw_video_thumb/example/pu/img/poster.jpg',
  },
  source: 'garden',
  pinned_at: '2026-07-27T00:00:00.000Z',
};

describe('buildQueueUrl', () => {
  it('requests only a bounded limit (no queued/opened semantics)', () => {
    expect(buildQueueUrl('https://feed.test:3335')).toBe(
      'https://feed.test:3335/api/marktab/queue?limit=12',
    );
    expect(buildQueueUrl('https://feed.test:3335/', { limit: 5 })).toBe(
      'https://feed.test:3335/api/marktab/queue?limit=5',
    );
    expect(buildQueueUrl('https://feed.test:3335', { limit: 0 })).toContain('limit=1');
    expect(buildQueueUrl('https://feed.test:3335', { limit: 500 })).toContain('limit=50');
  });
});

describe('buildHeaders', () => {
  it('adds Bearer and x-api-key headers when a token is present', () => {
    expect(buildHeaders('secret')).toEqual({
      Authorization: 'Bearer secret',
      'x-api-key': 'secret',
    });
  });

  it('omits auth headers when there is no token', () => {
    expect(buildHeaders('')).toEqual({});
  });
});

describe('safe URLs', () => {
  it('allows ordinary absolute http(s) navigation URLs only', () => {
    expect(safeHttpUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,nope')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
  });

  it('allows proven public X and GitHub media', () => {
    const poster = 'https://pbs.twimg.com/media/example.jpg';
    const video = 'https://video.twimg.com/ext_tw_video/example/pu/vid/avc1/clip.mp4';
    const github = 'https://opengraph.githubassets.com/hash/example/repo';
    expect(safeMediaUrl(poster)).toBe(poster);
    expect(safeMediaUrl(video)).toBe(video);
    expect(safeMediaUrl(github)).toBe(github);
  });

  it.each([
    'https://user:pass@example.com/image.jpg',
    'https://example.com/image.jpg?token=secret',
    'https://example.com/image.jpg?access_token=secret',
    'https://example.com/image.jpg?Authorization=Bearer',
    'https://example.com/image.jpg?x-api-key=secret',
    'https://example.com/image.jpg?signature=secret',
    'https://example.com/image.jpg?session=secret',
    'https://example.com/image.jpg?password=secret',
    'https://example.com/image.jpg?credential=secret',
    'https://cdn.example/image.jpg?X-Amz-Credential=user&X-Amz-Signature=secret&X-Amz-Expires=600',
    'https://cdn.example/image.jpg?X-Goog-Credential=user&X-Goog-Signature=secret',
    'https://cdn.example/image.jpg?Policy=p&Signature=s&Key-Pair-Id=k',
    'https://cdn.example/image.jpg?sv=2024-01-01&se=tomorrow&sp=r&sig=secret',
    'https://eden.example/api/garden/media/abc',
    'https://eden.example/%61pi/garden/media/abc',
    'https://eden.example/remote-media?url=x',
    'data:image/png;base64,abc',
    'javascript:alert(1)',
  ])('rejects credential-bearing, protected, and unsafe media URL %s', (url) => {
    expect(safeMediaUrl(url)).toBeNull();
  });

  it.each([
    'https://localhost/image.jpg',
    'https://media.local/image.jpg',
    'https://intranet/image.jpg',
    'https://127.0.0.1/image.jpg',
    'https://10.0.0.1/image.jpg',
    'https://169.254.1.1/image.jpg',
    'https://172.16.0.1/image.jpg',
    'https://192.168.1.1/image.jpg',
    'https://[::1]/image.jpg',
    'https://[fd00::1]/image.jpg',
    'https://[fe80::1]/image.jpg',
    'https://[ff00::1]/image.jpg',
    'https://[::7f00:1]/image.jpg',
    'https://[::a00:1]/image.jpg',
    'https://[::ffff:127.0.0.1]/image.jpg',
    'https://[0:0:0:0:0:ffff:7f00:1]/image.jpg',
  ])('rejects private or local media host %s', (url) => {
    expect(safeMediaUrl(url)).toBeNull();
  });

  it.each([
    'http://127.0.0.1/admin',
    'http://[ff00::1]/admin',
    'http://[::7f00:1]/admin',
    'http://[::a00:1]/admin',
    'https://user:pass@example.com/private',
    'https://example.com/private?token=secret',
    'https://example.com/private?signature=secret',
    'https://example.com/private?session=secret',
    'https://example.com/private?password=secret',
    'https://example.com/private?credential=secret',
  ])('rejects unsafe pin destination %s without tightening backend config URLs', (url) => {
    expect(safeDestinationUrl(url)).toBeNull();
    expect(safeHttpUrl(url)).toBe(url);
  });

  it('accepts only calendar-valid canonical UTC pin timestamps', () => {
    expect(isCanonicalPinTimestamp('2024-02-29T12:34:56.789Z')).toBe(true);
    for (const invalid of ['0', 'July 27, 2026', '2026-02-30T00:00:00Z', '2026-07-27T25:00:00Z']) {
      expect(isCanonicalPinTimestamp(invalid)).toBe(false);
    }
  });
});

describe('originPattern', () => {
  it('builds a port-less scheme+host match pattern', () => {
    expect(originPattern('https://host.example:3335/api')).toBe('https://host.example/*');
    expect(originPattern('http://localhost:8080')).toBe('http://localhost/*');
  });

  it('rejects invalid and wildcard origins', () => {
    expect(originPattern('javascript:alert(1)')).toBeNull();
    expect(originPattern('not a url')).toBeNull();
    expect(originPattern('https://*/*')).toBeNull();
    expect(originPattern('https://*.example.com/')).toBeNull();
  });
});

describe('host access permissions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('checks and requests only the configured origin and preserves a denial', async () => {
    const contains = vi.fn().mockResolvedValue(false);
    const request = vi.fn().mockResolvedValue(false);
    vi.stubGlobal('browser', { permissions: { contains, request } });

    await expect(hasHostAccess('https://pins.example:3335/api')).resolves.toBe(false);
    await expect(requestHostAccess('https://pins.example:3335/api')).resolves.toBe(false);
    expect(contains).toHaveBeenCalledWith({ origins: ['https://pins.example/*'] });
    expect(request).toHaveBeenCalledWith({ origins: ['https://pins.example/*'] });
  });

  it('does not invoke Chrome permissions for an invalid origin', async () => {
    const request = vi.fn();
    vi.stubGlobal('browser', { permissions: { request } });
    await expect(requestHostAccess('not a URL')).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('storage (config + cache V2)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage(initial: Record<string, unknown> = {}) {
    const store: Record<string, unknown> = { ...initial };
    const set = vi.fn(async (patch: Record<string, unknown>) => void Object.assign(store, patch));
    const get = vi.fn(async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in store).map((key) => [key, store[key]]));
    });
    const remove = vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    });
    const getURL = vi.fn((path: string) =>
      `chrome-extension://test${path.startsWith('/') ? path : `/${path}`}`);
    vi.stubGlobal('browser', { storage: { local: { get, set, remove } }, runtime: { getURL } });
    const bundledFetch = vi.fn().mockRejectedValue(new Error('not bundled'));
    vi.stubGlobal('fetch', bundledFetch);
    return { store, set, get, remove, getURL, bundledFetch };
  }

  it('returns stored canonical feed values when present', async () => {
    stubStorage({ feedBaseUrl: 'https://stored:1/', feedToken: 'tok' });
    expect(await loadConfig()).toEqual({ baseUrl: 'https://stored:1/', token: 'tok' });
  });

  it('migrates legacy config to canonical keys and clears both queue caches', async () => {
    const storage = stubStorage({
      edenBaseUrl: 'https://legacy:1/',
      edenToken: 'old',
      feedQueueCache: [{ historical: true }],
      feedPinsCacheV2: [item],
    });
    expect(await loadConfig()).toEqual({ baseUrl: 'https://legacy:1/', token: 'old' });
    expect(storage.set).toHaveBeenCalledWith({
      feedBaseUrl: 'https://legacy:1/',
      feedToken: 'old',
    });
    expect(storage.remove).toHaveBeenCalledWith([
      'feedQueueCache',
      'feedPinsCacheV2',
      'feedReviewCacheV1',
      'edenBaseUrl',
      'edenToken',
    ]);
  });

  it('uses and migrates a valid bundled config before legacy values', async () => {
    const storage = stubStorage({ edenBaseUrl: 'https://legacy.invalid/', edenToken: 'legacy' });
    storage.bundledFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ baseUrl: 'https://bundle.example/api/', token: 'bundle-placeholder' }),
    });

    expect(await loadConfig()).toEqual({
      baseUrl: 'https://bundle.example/api/',
      token: 'bundle-placeholder',
    });
    expect(storage.getURL).toHaveBeenCalledWith('/');
    expect(storage.bundledFetch).toHaveBeenCalledWith('chrome-extension://test/marktab-local.json', {
      cache: 'no-store',
    });
    expect(storage.remove).toHaveBeenCalledWith([
      'feedQueueCache',
      'feedPinsCacheV2',
      'feedReviewCacheV1',
      'edenBaseUrl',
      'edenToken',
    ]);
  });

  it.each([
    { baseUrl: 'http://bundle.example', token: 'bundle-placeholder' },
    { baseUrl: 'https://bundle.example', token: '' },
    { baseUrl: 'not a URL', token: 'bundle-placeholder' },
  ])('ignores invalid bundled config %#', async (bundled) => {
    const storage = stubStorage({ edenBaseUrl: 'https://legacy.example/', edenToken: 'legacy' });
    storage.bundledFetch.mockResolvedValue({ ok: true, json: async () => bundled });
    expect(await loadConfig()).toEqual({ baseUrl: 'https://legacy.example/', token: 'legacy' });
  });

  it('falls back to the empty default when storage and bundle are empty', async () => {
    const storage = stubStorage();
    storage.bundledFetch.mockResolvedValue({ ok: false, status: 404 });
    expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('saveConfig clears legacy and V2 caches so cards cannot cross sources', async () => {
    const storage = stubStorage();
    await saveConfig({ baseUrl: 'https://feed.test:3335', token: 'abc' });
    expect(storage.set).toHaveBeenCalledWith({ feedBaseUrl: 'https://feed.test:3335', feedToken: 'abc' });
    expect(storage.remove).toHaveBeenCalledWith([
      'feedQueueCache',
      'feedPinsCacheV2',
      'feedReviewCacheV1',
      'edenBaseUrl',
      'edenToken',
    ]);
  });

  it('round-trips canonical Garden pins through cache V2', async () => {
    stubStorage();
    await saveCachedItems([item]);
    expect(await loadCachedItems()).toEqual([item]);
  });

  it('serializes cache writes across page lifecycles with a shared Web Lock', async () => {
    const storage = stubStorage();
    const request = vi.fn(async (_name: string, callback: () => Promise<void>) => callback());
    vi.stubGlobal('navigator', { locks: { request } });
    await saveCachedItems([item]);
    expect(request).toHaveBeenCalledWith('marktab-pins-cache-v2-write', expect.any(Function));
    expect(storage.set).toHaveBeenCalledWith({ feedPinsCacheV2: [item] });
  });

  it('ignores the old queue cache and malformed/non-Garden V2 entries', async () => {
    const oldQueueItem = {
      id: 'old',
      title: 'Historical JSONL card',
      url: 'https://old.example',
      source: 'triage',
      queued_at: '2026-06-14T00:00:00.000Z',
      status: 'queued',
    };
    stubStorage({
      feedQueueCache: [oldQueueItem],
      feedPinsCacheV2: [
        item,
        oldQueueItem,
        { id: 'broken' },
        { ...item, id: '   ' },
        { ...item, title: '' },
        { ...item, url: 'javascript:alert(1)' },
        { ...item, url: 'http://127.0.0.1/admin' },
        { ...item, url: 'https://user:pass@example.com/private' },
        { ...item, pinned_at: 'not-a-date' },
        { ...item, pinned_at: '0' },
        { ...item, pinned_at: '2026-02-30T00:00:00Z' },
      ],
    });
    expect(await loadCachedItems()).toEqual([item]);
  });

  it('retains a core-valid cached pin while discarding malformed optional media', async () => {
    stubStorage({
      feedPinsCacheV2: [{ ...item, media: { kind: 'image', url: 'not a url' }, image_url: 'not a url' }],
    });
    const { media: _media, ...core } = item;
    expect(await loadCachedItems()).toEqual([core]);
  });
});

describe('latest cache writer', () => {
  it('serializes writes and leaves the newest queued projection durable', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const snapshots: string[][] = [];
    const write = vi.fn(async (items: PinItem[]) => {
      snapshots.push(items.map((candidate) => candidate.id));
      if (snapshots.length === 1) await firstBlocked;
    });
    const writer = createLatestCacheWriter(write);
    const older = writer.enqueue([{ ...item, id: 'older' }]);
    const newest = writer.enqueue([{ ...item, id: 'newest' }]);

    expect(snapshots).toEqual([['older']]);
    releaseFirst();
    await Promise.all([older, newest]);
    expect(snapshots).toEqual([['older'], ['newest']]);
  });

  it('continues to the newest queued projection when its predecessor write fails', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const durable: string[][] = [];
    let attempt = 0;
    const writer = createLatestCacheWriter(async (items) => {
      attempt += 1;
      if (attempt === 1) {
        await firstBlocked;
        throw new Error('older write failed');
      }
      durable.push(items.map((candidate) => candidate.id));
    });
    const older = writer.enqueue([{ ...item, id: 'older' }]);
    const newest = writer.enqueue([{ ...item, id: 'newest' }]);

    releaseFirst();
    await Promise.all([older, newest]);
    expect(durable).toEqual([['newest']]);
  });

  it('restarts cleanly when a newer enqueue arrives from a rejected completion boundary', async () => {
    const attempts: string[][] = [];
    let first = true;
    const writer = createLatestCacheWriter(async (items) => {
      attempts.push(items.map((candidate) => candidate.id));
      if (first) {
        first = false;
        throw new Error('first boundary failure');
      }
    });

    const older = writer.enqueue([{ ...item, id: 'older' }]);
    const newest = older.catch(() => writer.enqueue([{ ...item, id: 'newest' }]));
    await newest;
    expect(attempts).toEqual([['older'], ['newest']]);
  });
});

describe('createFeedClient', () => {
  it('uses GET-only reads and exposes no opened mutation API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [item] }));
    const client = createFeedClient(config, fetchImpl);
    expect(Object.keys(client)).toEqual(['fetchQueue', 'unpin']);
    await expect(client.fetchQueue()).resolves.toEqual([item]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://feed.test:3335/api/marktab/queue?limit=12');
    expect(init).toMatchObject({
      headers: { Authorization: 'Bearer secret', 'x-api-key': 'secret' },
      redirect: 'error',
    });
    expect(init.method).toBeUndefined();
  });

  it('returns [] for a canonical empty envelope and throws on non-OK reads', async () => {
    const emptyFetch = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    await expect(createFeedClient(config, emptyFetch).fetchQueue()).resolves.toEqual([]);

    const failedFetch = vi.fn().mockResolvedValue(jsonResponse(null, false, 500));
    await expect(createFeedClient(config, failedFetch).fetchQueue()).rejects.toThrow(
      'Feed fetch failed: 500',
    );
  });

  it.each([
    {},
    { items: [{ id: 'legacy', source: 'triage', status: 'queued' }] },
    { items: 'not-an-array' },
    { items: [{ ...item, id: '' }] },
    { items: [{ ...item, title: '   ' }] },
    { items: [{ ...item, url: '' }] },
    { items: [{ ...item, url: 'javascript:alert(1)' }] },
    { items: [{ ...item, url: 'http://127.0.0.1/admin' }] },
    { items: [{ ...item, url: 'https://user:pass@example.com/private' }] },
    { items: [{ ...item, pinned_at: 'not-a-date' }] },
    { items: [{ ...item, pinned_at: '0' }] },
    { items: [{ ...item, pinned_at: 'July 27, 2026' }] },
    { items: [{ ...item, pinned_at: '2026-02-30T00:00:00Z' }] },
  ])('rejects an incompatible non-canonical feed without treating it as empty %#', async (payload) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(payload));
    await expect(createFeedClient(config, fetchImpl).fetchQueue()).rejects.toThrow(
      'Feed response is incompatible with Garden Pins.',
    );
  });

  it.each([
    { kind: 'bogus', url: 'https://cdn.example/x' },
    { kind: 'image', url: 42 },
    { kind: 'image', url: '' },
    { kind: 'image', url: 'not a url' },
  ])('keeps a canonical pin and discards malformed optional media %#', async (media) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [{ ...item, media }] }));
    const [pin] = await createFeedClient(config, fetchImpl).fetchQueue();
    expect(pin.id).toBe(item.id);
    expect(pin.media).toBeUndefined();
  });

  it('keeps valid media while discarding a malformed poster alias', async () => {
    const media = { kind: 'video', url: 'https://cdn.example/x.mp4', poster_url: 'not a url' };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [{ ...item, media }] }));
    const [pin] = await createFeedClient(config, fetchImpl).fetchQueue();
    expect(pin.media).toEqual({ kind: 'video', url: 'https://cdn.example/x.mp4' });
  });

  it('POSTs only an explicit unpin to the compatibility dismiss endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, true, 204));
    const client = createFeedClient(config, fetchImpl);
    await client.unpin('a 1');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://feed.test:3335/api/marktab/queue/a%201/dismiss');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, redirect: 'error' });
  });

  it('sends no auth header with a no-token config', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    await createFeedClient({ baseUrl: 'https://feed.test:3335', token: '' }, fetchImpl).fetchQueue();
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({});
  });
});

describe('Garden search', () => {
  it('builds an encoded, bounded search URL on the configured base', () => {
    expect(buildGardenSearchUrl('https://feed.test:3335/', 'a&b c')).toBe(
      'https://feed.test:3335/api/marktab/search?q=a%26b+c&limit=8',
    );
  });

  it('links items only to same-origin rooted Eden paths', () => {
    expect(edenItemUrl('https://eden.test/', '/garden/abc')).toBe('https://eden.test/garden/abc');
    expect(edenItemUrl('https://eden.test', '//evil.example/x')).toBeNull();
    expect(edenItemUrl('https://eden.test', 'https://evil.example/x')).toBeNull();
    expect(edenItemUrl('https://eden.test', '/\\evil.example')).toBeNull();
    expect(edenItemUrl('https://eden.test', 'garden/abc')).toBeNull();
  });

  it('keeps valid items, drops malformed ones and unsafe url/image fields', () => {
    const items = parseGardenSearch({
      items: [
        {
          id: 'g1',
          title: ' Spring easing ',
          url: 'https://example.com/post',
          eden_path: '/garden/g1',
          type: 'ingredient',
          image_url: 'https://pbs.twimg.com/media/a.jpg',
        },
        { id: 'g2', title: 'No source', url: null, eden_path: '/garden/g2', image_url: 'https://eden.test/api/garden/media/x' },
        { id: 'g3', title: 'Script', url: 'javascript:alert(1)', eden_path: '/garden/g3' },
        { id: 'bad', title: 'No path', url: null },
        { id: '', title: 'No id', eden_path: '/x' },
      ],
    });
    expect(items).toEqual([
      {
        id: 'g1',
        title: 'Spring easing',
        url: 'https://example.com/post',
        eden_path: '/garden/g1',
        type: 'ingredient',
        image_url: 'https://pbs.twimg.com/media/a.jpg',
      },
      { id: 'g2', title: 'No source', url: null, eden_path: '/garden/g2' },
      { id: 'g3', title: 'Script', url: null, eden_path: '/garden/g3' },
    ]);
    expect(() => parseGardenSearch({ results: [] })).toThrow(FeedContractError);
  });

  it('sends the queue auth headers and the abort signal, and names HTTP failures', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    await expect(fetchGardenSearch(config, 'x', controller.signal, fetchImpl)).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith('https://feed.test:3335/api/marktab/search?q=x&limit=8', {
      headers: { Authorization: 'Bearer secret', 'x-api-key': 'secret' },
      redirect: 'error',
      signal: controller.signal,
    });

    const missing = vi.fn().mockResolvedValue(jsonResponse({}, false, 404));
    const error = await fetchGardenSearch(config, 'x', undefined, missing).catch((e) => e);
    expect(error).toBeInstanceOf(FeedHttpError);
    expect(feedErrorKind(error)).toBe('missing');
  });

  it('classifies failures into the causes the UI names', () => {
    expect(feedErrorKind(new FeedHttpError(401))).toBe('auth');
    expect(feedErrorKind(new FeedHttpError(403))).toBe('auth');
    expect(feedErrorKind(new FeedHttpError(404))).toBe('missing');
    expect(feedErrorKind(new FeedHttpError(502))).toBe('server');
    expect(feedErrorKind(new FeedContractError())).toBe('server');
    expect(feedErrorKind(new TypeError('Failed to fetch'))).toBe('offline');
    expect(new FeedHttpError(500).message).toBe('Feed fetch failed: 500');
  });
});

describe('Review', () => {
  const post = { id: 'r1', title: 'Draft post', summary: 'A summary', kind: 'tweet', created_at: '2026-10-26T08:00:00.000Z' };

  it('builds the review API and page URLs on the configured base', () => {
    expect(buildReviewUrl('https://eden.test/')).toBe('https://eden.test/api/marktab/review?limit=6');
    expect(reviewPageUrl('https://eden.test/')).toBe('https://eden.test/review');
  });

  it('parses the envelope, drops malformed posts and keeps total ≥ shown rows', () => {
    expect(parseReviewEnvelope({ total: 14, items: [post, { id: 'x', title: 'No date' }] })).toEqual({
      total: 14,
      items: [post],
    });
    expect(parseReviewEnvelope({ items: [post] }).total).toBe(1);
    expect(parseReviewEnvelope({ total: 0, items: [post] }).total).toBe(1);
    expect(() => parseReviewEnvelope(null)).toThrow(FeedContractError);
  });

  it('fetches with auth headers and surfaces a 404 as missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ total: 1, items: [post] }));
    await expect(fetchReview(config, undefined, fetchImpl)).resolves.toEqual({ total: 1, items: [post] });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://feed.test:3335/api/marktab/review?limit=6');
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer secret', 'x-api-key': 'secret' });

    const missing = vi.fn().mockResolvedValue(jsonResponse({}, false, 404));
    expect(feedErrorKind(await fetchReview(config, undefined, missing).catch((e) => e))).toBe('missing');
  });

  it('round-trips the cache and ignores a damaged one', async () => {
    const store: Record<string, unknown> = {};
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
          set: async (patch: Record<string, unknown>) => void Object.assign(store, patch),
        },
      },
    });
    expect(await loadCachedReview()).toBeNull();
    await saveCachedReview({ total: 3, items: [post] });
    expect(await loadCachedReview()).toEqual({ total: 3, items: [post] });
    store.feedReviewCacheV1 = 'garbage';
    expect(await loadCachedReview()).toBeNull();
    vi.unstubAllGlobals();
  });
});
