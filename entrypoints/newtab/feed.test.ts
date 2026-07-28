import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  buildHeaders,
  buildQueueUrl,
  createFeedClient,
  hasHostAccess,
  loadCachedItems,
  loadConfig,
  originPattern,
  requestHostAccess,
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
  ])('rejects private or local media host %s', (url) => {
    expect(safeMediaUrl(url)).toBeNull();
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
      'edenBaseUrl',
      'edenToken',
    ]);
  });

  it('round-trips canonical Garden pins through cache V2', async () => {
    stubStorage();
    await saveCachedItems([item]);
    expect(await loadCachedItems()).toEqual([item]);
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
      feedPinsCacheV2: [item, oldQueueItem, { id: 'broken' }],
    });
    expect(await loadCachedItems()).toEqual([item]);
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

  it('returns [] when the payload has no items and throws on non-OK reads', async () => {
    const emptyFetch = vi.fn().mockResolvedValue(jsonResponse({}));
    await expect(createFeedClient(config, emptyFetch).fetchQueue()).resolves.toEqual([]);

    const failedFetch = vi.fn().mockResolvedValue(jsonResponse(null, false, 500));
    await expect(createFeedClient(config, failedFetch).fetchQueue()).rejects.toThrow(
      'Feed fetch failed: 500',
    );
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
