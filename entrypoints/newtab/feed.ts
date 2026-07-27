// Data layer for the "Pins" feed — the only part of marktab that makes
// network requests, and only to the host the user configures. Kept free of
// `browser`/DOM globals (except the storage/permission helpers) so the adapter
// is unit-testable under a plain Node Vitest run with an injected fetch.

// Mirrors the server's JSON response (snake_case is intentional — it's the wire shape).
export interface QueueItem {
  id: string;
  title: string;
  url: string;
  description?: string;
  image_url?: string;
  source: string;
  author?: string;
  queued_at: string;
  status: 'queued';
}

export interface FeedConfig {
  baseUrl: string;
  token: string;
}

/** No host by default — the feed is dormant until the user configures one in
 *  Settings (their host lives in browser.storage.local, never in the code). */
export const DEFAULT_CONFIG: FeedConfig = {
  baseUrl: '',
  token: '',
};

interface QueueQuery {
  status?: 'queued';
  limit?: number;
}

/** Strip a trailing slash so we can join paths without doubling up. */
function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** GET URL for the queue endpoint, with status/limit as query params. */
export function buildQueueUrl(baseUrl: string, { status = 'queued', limit = 12 }: QueueQuery = {}): string {
  const params = new URLSearchParams({ status, limit: String(limit) });
  return `${trimBase(baseUrl)}/api/marktab/queue?${params}`;
}

/** Auth headers understood by both Bearer-token and API-key backends. */
export function buildHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}`, 'x-api-key': token } : {};
}

/** Queue items are remote-controlled, so a `javascript:`/`data:` URL would run in
 *  the privileged extension origin. Return the URL only if it's plain http(s). */
export function safeHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:' ? raw : null;
  } catch {
    return null; // not a parseable absolute URL
  }
}

export interface FeedClient {
  fetchQueue(query?: QueueQuery): Promise<QueueItem[]>;
  markOpened(id: string): Promise<void>;
  dismiss(id: string): Promise<void>;
}

/** Build a client bound to a config + fetch impl. Inject both to mock in tests. */
export function createFeedClient(config: FeedConfig, fetchImpl: typeof fetch = fetch): FeedClient {
  const base = trimBase(config.baseUrl);
  const headers = buildHeaders(config.token);

  const post = (id: string, action: 'opened' | 'dismiss') =>
    fetchImpl(`${base}/api/marktab/queue/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers,
      keepalive: true,
      redirect: 'error',
    }).then((response) => {
      if (!response.ok) throw new Error(`Feed ${action} ${id} failed: ${response.status}`);
    });

  return {
    async fetchQueue(query) {
      const response = await fetchImpl(buildQueueUrl(base, query), { headers, redirect: 'error' });
      if (!response.ok) throw new Error(`Feed fetch failed: ${response.status}`);
      const data = (await response.json()) as { items?: QueueItem[] };
      return data.items ?? [];
    },
    markOpened: (id) => post(id, 'opened'),
    dismiss: (id) => post(id, 'dismiss'),
  };
}

// --- The host-access + storage helpers below are the only `browser.*` touches ---

/** Permission match pattern for a base URL: scheme + host, no port (match
 *  patterns can't carry a port; the grant is port-agnostic). */
export function originPattern(baseUrl: string): string | null {
  if (!safeHttpUrl(baseUrl)) return null;
  const { protocol, hostname } = new URL(baseUrl);
  if (!hostname || hostname.includes('*')) return null;
  return `${protocol}//${hostname}/*`;
}

export async function hasHostAccess(baseUrl: string): Promise<boolean> {
  const origin = originPattern(baseUrl);
  return origin ? browser.permissions.contains({ origins: [origin] }) : false;
}

export async function requestHostAccess(baseUrl: string): Promise<boolean> {
  const origin = originPattern(baseUrl);
  return origin ? browser.permissions.request({ origins: [origin] }) : false;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const CACHE_KEY = 'feedQueueCache';
const LOCAL_CONFIG_FILE = 'marktab-local.json';

/** A bundled config is only produced by `npm run build:local`. Public builds do
 *  not contain this file. Require HTTPS because this path always carries a key. */
function normaliseBundledConfig(value: unknown): FeedConfig | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isString(candidate.baseUrl) || !isString(candidate.token)) return null;
  const baseUrl = candidate.baseUrl.trim();
  const token = candidate.token.trim();
  if (!baseUrl || !token) return null;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.hostname.includes('*')) return null;
  } catch {
    return null;
  }
  return { baseUrl, token };
}

async function loadBundledConfig(): Promise<FeedConfig | null> {
  try {
    const url = new URL(LOCAL_CONFIG_FILE, browser.runtime.getURL('/')).href;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    return normaliseBundledConfig(await response.json());
  } catch {
    // The generic public build intentionally has no bundled local config.
    return null;
  }
}

/** Read base URL + token from storage. Any canonical `feed*` value makes that
 *  pair authoritative, preventing legacy or bundled data from filling a missing
 *  field. Otherwise prefer the optional local-build bundle, then legacy keys. */
export async function loadConfig(): Promise<FeedConfig> {
  const stored = await browser.storage.local.get([
    'feedBaseUrl',
    'feedToken',
    'edenBaseUrl',
    'edenToken',
  ]);

  if (isString(stored.feedBaseUrl) || isString(stored.feedToken)) {
    return {
      baseUrl: isString(stored.feedBaseUrl) ? stored.feedBaseUrl : DEFAULT_CONFIG.baseUrl,
      token: isString(stored.feedToken) ? stored.feedToken : DEFAULT_CONFIG.token,
    };
  }

  const bundled = await loadBundledConfig();
  if (bundled) {
    await browser.storage.local.set({ feedBaseUrl: bundled.baseUrl, feedToken: bundled.token });
    await browser.storage.local.remove([CACHE_KEY, 'edenBaseUrl', 'edenToken']);
    return bundled;
  }

  return {
    baseUrl: isString(stored.edenBaseUrl) ? stored.edenBaseUrl : DEFAULT_CONFIG.baseUrl,
    token: isString(stored.edenToken) ? stored.edenToken : DEFAULT_CONFIG.token,
  };
}

export async function saveConfig(config: FeedConfig): Promise<void> {
  await browser.storage.local.set({ feedBaseUrl: config.baseUrl, feedToken: config.token });
  await browser.storage.local.remove([CACHE_KEY, 'edenBaseUrl', 'edenToken']);
}

function isQueueItem(value: unknown): value is QueueItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.url === 'string' && typeof item.title === 'string';
}

export async function loadCachedItems(): Promise<QueueItem[]> {
  const stored = await browser.storage.local.get(CACHE_KEY);
  const cached = stored[CACHE_KEY];
  return Array.isArray(cached) ? cached.filter(isQueueItem) : [];
}

export async function saveCachedItems(items: QueueItem[]): Promise<void> {
  await browser.storage.local.set({ [CACHE_KEY]: items });
}
