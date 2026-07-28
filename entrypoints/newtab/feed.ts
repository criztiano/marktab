// Data layer for the optional "Pins" feed — Marktab's only network client.
// It stays dormant until the user configures and grants one backend host.

export interface PinMedia {
  kind: 'image' | 'video';
  url: string;
  poster_url?: string;
}

// Canonical Garden-backed wire shape (snake_case is intentional).
export interface PinItem {
  id: string;
  title: string;
  url: string;
  media?: PinMedia;
  image_url?: string; // compatibility alias for older Garden producers
  source: 'garden';
  pinned_at: string;
}

export interface FeedConfig {
  baseUrl: string;
  token: string;
}

/** No host by default: public builds make no network request until configured. */
export const DEFAULT_CONFIG: FeedConfig = {
  baseUrl: '',
  token: '',
};

interface QueueQuery {
  limit?: number;
}

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;
const LEGACY_CACHE_KEY = 'feedQueueCache';
const CACHE_KEY = 'feedPinsCacheV2';
const LOCAL_CONFIG_FILE = 'marktab-local.json';
const CONFIG_MIGRATION_KEYS = [LEGACY_CACHE_KEY, CACHE_KEY, 'edenBaseUrl', 'edenToken'];

/** Strip a trailing slash so paths join without doubling up. */
function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function boundedLimit(value = DEFAULT_LIMIT): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

/** Garden Pins GET URL. Persistence makes queued/opened query semantics obsolete. */
export function buildQueueUrl(baseUrl: string, { limit }: QueueQuery = {}): string {
  const params = new URLSearchParams({ limit: String(boundedLimit(limit)) });
  return `${trimBase(baseUrl)}/api/marktab/queue?${params}`;
}

/** Auth headers understood by both Bearer-token and API-key backends. */
export function buildHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}`, 'x-api-key': token } : {};
}

/** Remote navigation is allowed only to parseable absolute HTTP(S) URLs. */
export function safeHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/** Media elements cannot send the feed token, so only direct public HTTP(S)
 * resources belong in img/video. In particular, reject Eden's authenticated
 * media proxy routes (observed to fail without auth) and credentialed URLs. */
function hasSensitiveMediaQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      compact.includes('token') ||
      compact === 'auth' ||
      compact === 'authorization' ||
      compact === 'authentication' ||
      compact === 'oauth' ||
      compact === 'apikey' ||
      compact === 'xapikey' ||
      (compact.startsWith('auth') && !compact.startsWith('author'))
    ) {
      return true;
    }
  }
  return false;
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home') ||
    (!host.includes('.') && !host.includes(':'))
  ) {
    return true;
  }

  const octets = host.split('.');
  if (octets.length === 4 && octets.every((part) => /^\d+$/.test(part))) {
    const [a, b] = octets.map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (!host.includes(':')) return false;
  if (host === '::' || host === '::1' || host.startsWith('::ffff:')) return true;
  const firstHextet = Number.parseInt(host.split(':', 1)[0], 16);
  return (
    Number.isFinite(firstHextet) &&
    ((firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80)
  );
}

function decodedPathname(pathname: string): string | null {
  let decoded = pathname.toLowerCase();
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function safeMediaUrl(raw: string | undefined): string | null {
  if (!safeHttpUrl(raw)) return null;
  try {
    const parsed = new URL(raw!);
    if (
      parsed.username ||
      parsed.password ||
      isPrivateOrLocalHost(parsed.hostname) ||
      hasSensitiveMediaQuery(parsed)
    ) {
      return null;
    }
    const path = decodedPathname(parsed.pathname);
    if (path === null) return null;
    if (
      path === '/api/garden/media' ||
      path.startsWith('/api/garden/media/') ||
      /(?:^|\/)remote-media(?:\/|$)/.test(path)
    ) {
      return null;
    }
    return raw!;
  } catch {
    return null;
  }
}

export interface FeedClient {
  fetchQueue(query?: QueueQuery): Promise<PinItem[]>;
  /** Explicit user action; retained against the backend compatibility route. */
  unpin(id: string): Promise<void>;
}

/** Build a client bound to a config + fetch implementation for easy testing. */
export function createFeedClient(config: FeedConfig, fetchImpl: typeof fetch = fetch): FeedClient {
  const base = trimBase(config.baseUrl);
  const headers = buildHeaders(config.token);

  return {
    async fetchQueue(query) {
      const response = await fetchImpl(buildQueueUrl(base, query), { headers, redirect: 'error' });
      if (!response.ok) throw new Error(`Feed fetch failed: ${response.status}`);
      const data = (await response.json()) as { items?: unknown };
      return Array.isArray(data.items) ? data.items.filter(isPinItem) : [];
    },
    async unpin(id) {
      const response = await fetchImpl(
        `${base}/api/marktab/queue/${encodeURIComponent(id)}/dismiss`,
        {
          method: 'POST',
          headers,
          keepalive: true,
          redirect: 'error',
        },
      );
      if (!response.ok) throw new Error(`Feed dismiss ${id} failed: ${response.status}`);
    },
  };
}

// --- Host-access + storage helpers: the only browser.* touches in this module ---

/** Permission match pattern: scheme + host, no port (match patterns cannot carry one). */
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

/** A bundled config exists only in private local builds. Require HTTPS because
 * this path always carries a key. */
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
    // Generic public builds intentionally have no bundled local config.
    return null;
  }
}

async function persistMigratedConfig(config: FeedConfig): Promise<void> {
  await browser.storage.local.set({ feedBaseUrl: config.baseUrl, feedToken: config.token });
  await browser.storage.local.remove(CONFIG_MIGRATION_KEYS);
}

/** Read canonical config, otherwise migrate a local bundle or legacy eden* keys.
 * Every migration invalidates both queue-cache generations. */
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
    await persistMigratedConfig(bundled);
    return bundled;
  }

  if (isString(stored.edenBaseUrl) || isString(stored.edenToken)) {
    const legacy = {
      baseUrl: isString(stored.edenBaseUrl) ? stored.edenBaseUrl : DEFAULT_CONFIG.baseUrl,
      token: isString(stored.edenToken) ? stored.edenToken : DEFAULT_CONFIG.token,
    };
    await persistMigratedConfig(legacy);
    return legacy;
  }

  return DEFAULT_CONFIG;
}

export async function saveConfig(config: FeedConfig): Promise<void> {
  await browser.storage.local.set({ feedBaseUrl: config.baseUrl, feedToken: config.token });
  await browser.storage.local.remove(CONFIG_MIGRATION_KEYS);
}

function isPinMedia(value: unknown): value is PinMedia {
  if (typeof value !== 'object' || value === null) return false;
  const media = value as Record<string, unknown>;
  return (
    (media.kind === 'image' || media.kind === 'video') &&
    isString(media.url) &&
    (media.poster_url === undefined || isString(media.poster_url))
  );
}

function isPinItem(value: unknown): value is PinItem {
  if (typeof value !== 'object' || value === null) return false;
  const pin = value as Record<string, unknown>;
  return (
    isString(pin.id) &&
    isString(pin.title) &&
    isString(pin.url) &&
    pin.source === 'garden' &&
    isString(pin.pinned_at) &&
    (pin.media === undefined || isPinMedia(pin.media)) &&
    (pin.image_url === undefined || isString(pin.image_url))
  );
}

export async function loadCachedItems(): Promise<PinItem[]> {
  const stored = await browser.storage.local.get(CACHE_KEY);
  const cached = stored[CACHE_KEY];
  return Array.isArray(cached) ? cached.filter(isPinItem) : [];
}

export async function saveCachedItems(items: PinItem[]): Promise<void> {
  await browser.storage.local.set({ [CACHE_KEY]: items });
}
