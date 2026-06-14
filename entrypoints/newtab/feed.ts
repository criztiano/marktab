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

/** Auth header, only when a token is configured. */
export function buildHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
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

  // Fire-and-forget POST callbacks. keepalive lets `opened` complete even though
  // clicking a card navigates this tab away immediately afterward.
  const post = (id: string, action: 'opened' | 'dismiss') =>
    fetchImpl(`${base}/api/marktab/queue/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers,
      keepalive: true,
    }).then((res) => {
      if (!res.ok) throw new Error(`Feed ${action} ${id} failed: ${res.status}`);
    });

  return {
    async fetchQueue(query) {
      const res = await fetchImpl(buildQueueUrl(base, query), { headers });
      if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);
      // Items are shape-validated at render (safeHttpUrl in Pins), not here.
      const data = (await res.json()) as { items?: QueueItem[] };
      return data.items ?? [];
    },
    markOpened: (id) => post(id, 'opened'),
    dismiss: (id) => post(id, 'dismiss'),
  };
}

// --- The host-access + storage helpers below are the only `browser.*` touches ---

/** Permission match pattern for a base URL: scheme + host, no port (match
 *  patterns can't carry a port; the grant is port-agnostic). Returns null for
 *  invalid or wildcard hosts, so a wildcard value can't be turned into an
 *  all-sites grant. */
export function originPattern(baseUrl: string): string | null {
  if (!safeHttpUrl(baseUrl)) return null;
  const { protocol, hostname } = new URL(baseUrl);
  if (!hostname || hostname.includes('*')) return null;
  return `${protocol}//${hostname}/*`;
}

/** Whether the user has already granted access to this host. */
export async function hasHostAccess(baseUrl: string): Promise<boolean> {
  const origin = originPattern(baseUrl);
  return origin ? browser.permissions.contains({ origins: [origin] }) : false;
}

/** Ask the browser for access to this host. MUST be called from a user gesture. */
export async function requestHostAccess(baseUrl: string): Promise<boolean> {
  const origin = originPattern(baseUrl);
  return origin ? browser.permissions.request({ origins: [origin] }) : false;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const pickString = (...vals: unknown[]): string | undefined => vals.find(isString);

/** Read base URL + token from storage, falling back to the legacy `eden*` keys
 *  (one-time migration for installs from before the rename), then to defaults. */
export async function loadConfig(): Promise<FeedConfig> {
  const s = await browser.storage.local.get(['feedBaseUrl', 'feedToken', 'edenBaseUrl', 'edenToken']);
  return {
    baseUrl: pickString(s.feedBaseUrl, s.edenBaseUrl) ?? DEFAULT_CONFIG.baseUrl,
    token: pickString(s.feedToken, s.edenToken) ?? DEFAULT_CONFIG.token,
  };
}

const CACHE_KEY = 'feedQueueCache';

/** Persist base URL + token. Clears the queue cache so a host/token change
 *  doesn't briefly show the previous host's items, and drops any legacy `eden*`
 *  keys now that they've been migrated. */
export async function saveConfig(config: FeedConfig): Promise<void> {
  await browser.storage.local.set({ feedBaseUrl: config.baseUrl, feedToken: config.token });
  await browser.storage.local.remove([CACHE_KEY, 'edenBaseUrl', 'edenToken']);
}

/** Cached items come from persisted storage, which can outlive a schema change
 *  or be hand-edited — validate the shape before trusting them downstream. */
function isQueueItem(v: unknown): v is QueueItem {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.url === 'string' && typeof o.title === 'string';
}

/** Last-seen queue items, for an instant (skeleton-free) render on the next open. */
export async function loadCachedItems(): Promise<QueueItem[]> {
  const stored = await browser.storage.local.get(CACHE_KEY);
  const cached = stored[CACHE_KEY];
  return Array.isArray(cached) ? cached.filter(isQueueItem) : [];
}

export async function saveCachedItems(items: QueueItem[]): Promise<void> {
  await browser.storage.local.set({ [CACHE_KEY]: items });
}
