import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildQueueUrl,
  buildHeaders,
  createFeedClient,
  safeHttpUrl,
  originPattern,
  hasHostAccess,
  requestHostAccess,
  loadConfig,
  saveConfig,
  loadCachedItems,
  saveCachedItems,
  DEFAULT_CONFIG,
  type FeedConfig,
  type QueueItem,
} from './feed';

const config: FeedConfig = { baseUrl: 'https://feed.test:3335', token: 'secret' };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('buildQueueUrl', () => {
  it('defaults to queued status and a limit of 12', () => {
    expect(buildQueueUrl('https://feed.test:3335')).toBe(
      'https://feed.test:3335/api/marktab/queue?status=queued&limit=12',
    );
  });

  it('honors an explicit limit and trims a trailing slash on the base', () => {
    expect(buildQueueUrl('https://feed.test:3335/', { limit: 5 })).toBe(
      'https://feed.test:3335/api/marktab/queue?status=queued&limit=5',
    );
  });
});

describe('buildHeaders', () => {
  it('adds Bearer and x-api-key headers when a token is present', () => {
    expect(buildHeaders('secret')).toEqual({
      Authorization: 'Bearer secret',
      'x-api-key': 'secret',
    });
  });

  it('omits the header when there is no token', () => {
    expect(buildHeaders('')).toEqual({});
  });
});

describe('originPattern', () => {
  it('builds a port-less scheme+host match pattern', () => {
    expect(originPattern('https://host.example:3335/api')).toBe('https://host.example/*');
    expect(originPattern('http://localhost:8080')).toBe('http://localhost/*');
  });

  it('returns null for non-http(s) or invalid input', () => {
    expect(originPattern('javascript:alert(1)')).toBeNull();
    expect(originPattern('not a url')).toBeNull();
    expect(originPattern('')).toBeNull();
  });

  it('rejects wildcard hosts so they cannot become an all-sites grant', () => {
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
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({ origins: ['https://pins.example/*'] });
  });

  it('does not invoke Chrome permissions for an invalid origin', async () => {
    const request = vi.fn();
    vi.stubGlobal('browser', { permissions: { request } });

    await expect(requestHostAccess('not a URL')).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('storage (config + cache)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage(initial: Record<string, unknown> = {}) {
    const store: Record<string, unknown> = { ...initial };
    const set = vi.fn(async (patch: Record<string, unknown>) => void Object.assign(store, patch));
    const get = vi.fn(async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
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

  it('loadConfig returns stored feed values when present', async () => {
    stubStorage({ feedBaseUrl: 'https://stored:1/', feedToken: 'tok' });
    expect(await loadConfig()).toEqual({ baseUrl: 'https://stored:1/', token: 'tok' });
  });

  it('loadConfig migrates legacy eden* keys when feed* are absent', async () => {
    stubStorage({ edenBaseUrl: 'https://legacy:1/', edenToken: 'old' });
    expect(await loadConfig()).toEqual({ baseUrl: 'https://legacy:1/', token: 'old' });
  });

  it('loadConfig prefers feed* over legacy eden* for both fields', async () => {
    stubStorage({
      feedBaseUrl: 'https://new/',
      feedToken: 'newtok',
      edenBaseUrl: 'https://legacy/',
      edenToken: 'oldtok',
    });
    expect(await loadConfig()).toEqual({ baseUrl: 'https://new/', token: 'newtok' });
  });

  it('loadConfig treats any canonical feed* storage as authoritative', async () => {
    stubStorage({ feedBaseUrl: 'https://new/', edenToken: 'oldtok' });
    expect(await loadConfig()).toEqual({ baseUrl: 'https://new/', token: '' });
  });

  it('loadConfig uses and migrates a valid bundled config before legacy values', async () => {
    const storage = stubStorage({
      edenBaseUrl: 'https://legacy.invalid/',
      edenToken: 'legacy-placeholder',
      feedQueueCache: ['stale'],
    });
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
    expect(storage.set).toHaveBeenCalledWith({
      feedBaseUrl: 'https://bundle.example/api/',
      feedToken: 'bundle-placeholder',
    });
    expect(storage.remove).toHaveBeenCalledWith([
      'feedQueueCache',
      'edenBaseUrl',
      'edenToken',
    ]);
  });

  it.each([
    { baseUrl: 'http://bundle.example', token: 'bundle-placeholder' },
    { baseUrl: 'https://bundle.example', token: '' },
    { baseUrl: 'not a URL', token: 'bundle-placeholder' },
  ])('loadConfig ignores invalid bundled config %#', async (bundled) => {
    const storage = stubStorage({ edenBaseUrl: 'https://legacy.example/', edenToken: 'legacy' });
    storage.bundledFetch.mockResolvedValue({ ok: true, json: async () => bundled });

    expect(await loadConfig()).toEqual({ baseUrl: 'https://legacy.example/', token: 'legacy' });
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('loadConfig ignores a missing bundled file and remains dormant', async () => {
    const storage = stubStorage();
    storage.bundledFetch.mockResolvedValue({ ok: false, status: 404 });
    expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('loadConfig falls back to the empty default when storage is empty', async () => {
    stubStorage();
    expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.baseUrl).toBe('');
  });

  it('saveConfig writes the feed keys and clears the cache + legacy keys', async () => {
    const { set, remove } = stubStorage();
    await saveConfig({ baseUrl: 'https://feed.test:3335', token: 'abc' });
    expect(set).toHaveBeenCalledWith({ feedBaseUrl: 'https://feed.test:3335', feedToken: 'abc' });
    expect(remove).toHaveBeenCalledWith(['feedQueueCache', 'edenBaseUrl', 'edenToken']);
  });

  const item: QueueItem = {
    id: 'c1',
    title: 'Cached',
    url: 'https://example.com',
    source: 'triage',
    queued_at: '2026-06-14T00:00:00.000Z',
    status: 'queued',
  };

  it('saveCachedItems then loadCachedItems round-trips the items', async () => {
    stubStorage();
    await saveCachedItems([item]);
    expect(await loadCachedItems()).toEqual([item]);
  });

  it('loadCachedItems returns [] when nothing is cached', async () => {
    stubStorage();
    expect(await loadCachedItems()).toEqual([]);
  });

  it('loadCachedItems returns [] when the cached value is not an array', async () => {
    stubStorage({ feedQueueCache: 'corrupt' });
    expect(await loadCachedItems()).toEqual([]);
  });

  it('loadCachedItems filters out malformed items', async () => {
    stubStorage({ feedQueueCache: [item, { garbage: true }, 'nope', { id: 'x' }] });
    expect(await loadCachedItems()).toEqual([item]);
  });
});

describe('safeHttpUrl', () => {
  it('passes through http and https URLs', () => {
    expect(safeHttpUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com');
  });

  it('rejects javascript:, data:, and other schemes', () => {
    expect(safeHttpUrl('javascript:alert(document.cookie)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHttpUrl('chrome-extension://abc/x')).toBeNull();
  });

  it('rejects unparseable or empty input', () => {
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
  });
});

describe('createFeedClient', () => {
  const item: QueueItem = {
    id: 'a1',
    title: 'Hello',
    url: 'https://example.com',
    source: 'triage',
    queued_at: '2026-06-14T00:00:00.000Z',
    status: 'queued',
  };

  it('fetchQueue requests the queue URL with auth and returns items', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [item] }));
    const items = await createFeedClient(config, fetchImpl).fetchQueue();

    expect(items).toEqual([item]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://feed.test:3335/api/marktab/queue?status=queued&limit=12');
    expect(init).toMatchObject({
      headers: { Authorization: 'Bearer secret', 'x-api-key': 'secret' },
      redirect: 'error',
    });
  });

  it('fetchQueue returns [] when the payload has no items', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    expect(await createFeedClient(config, fetchImpl).fetchQueue()).toEqual([]);
  });

  it('fetchQueue throws on a non-OK response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(null, false, 500));
    await expect(createFeedClient(config, fetchImpl).fetchQueue()).rejects.toThrow(
      'Feed fetch failed: 500',
    );
  });

  it('markOpened POSTs the opened callback with keepalive', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, true, 204));
    await createFeedClient(config, fetchImpl).markOpened('a 1');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://feed.test:3335/api/marktab/queue/a%201/opened');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, redirect: 'error' });
    expect(init.headers).toEqual({ Authorization: 'Bearer secret', 'x-api-key': 'secret' });
  });

  it('markOpened rejects on a non-OK response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(null, false, 500));
    await expect(createFeedClient(config, fetchImpl).markOpened('a1')).rejects.toThrow(
      'Feed opened a1 failed: 500',
    );
  });

  it('dismiss POSTs the dismiss callback', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, true, 204));
    await createFeedClient(config, fetchImpl).dismiss('a1');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://feed.test:3335/api/marktab/queue/a1/dismiss');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, redirect: 'error' });
    expect(init.headers).toEqual({ Authorization: 'Bearer secret', 'x-api-key': 'secret' });
  });

  it('a no-token config sends no auth header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    await createFeedClient({ baseUrl: 'https://feed.test:3335', token: '' }, fetchImpl).fetchQueue();
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({});
  });
});
