// Data layer for the optional "Pins" feed — Marktab's only network client.
// It stays dormant until the user configures and grants one backend host.

import { readBundledJson } from './local-config';

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
  const keys = Array.from(url.searchParams.keys(), (key) =>
    key.toLowerCase().replace(/[^a-z0-9]/g, ''),
  );
  const explicitParts = [
    'accesskey',
    'apikey',
    'authorisation',
    'authorization',
    'credential',
    'keypairid',
    'oauth',
    'password',
    'secret',
    'session',
    'signature',
    'signed',
    'token',
  ];
  for (const compact of keys) {
    if (
      compact === 'auth' ||
      compact === 'key' ||
      compact === 'policy' ||
      compact === 'se' ||
      compact === 'sig' ||
      compact === 'sp' ||
      compact === 'sv' ||
      explicitParts.some((part) => compact.includes(part))
    ) {
      return true;
    }
  }

  // Standard signed-capability families are credentials even when none of
  // their individual parameter names says "token" or "auth".
  if (keys.some((key) => key.startsWith('xamz') || key.startsWith('xgoog'))) return true;
  const keySet = new Set(keys);
  return keySet.has('sig') && ['sv', 'se', 'sp', 'sr', 'skoid', 'sktid'].some((key) => keySet.has(key));
}

function ipv6Bytes(hostname: string): number[] | null {
  let host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const zoneIndex = host.indexOf('%');
  if (zoneIndex >= 0) host = host.slice(0, zoneIndex);
  const lastColon = host.lastIndexOf(':');
  if (host.includes('.') && lastColon >= 0) {
    const dotted = host.slice(lastColon + 1);
    if (!/^\d+(?:\.\d+){3}$/.test(dotted)) return null;
    const octets = dotted.split('.').map(Number);
    if (octets.some((part) => part < 0 || part > 255)) return null;
    host = `${host.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function embeddedIpv4(bytes: number[]): string | null {
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  return mapped || compatible ? bytes.slice(12).join('.') : null;
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
  const bytes = ipv6Bytes(host);
  if (!bytes) return true;
  const embedded = embeddedIpv4(bytes);
  if (embedded && isPrivateOrLocalHost(embedded)) return true;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] <= 1) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  return bytes[0] === 0xff;
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

export function safeDestinationUrl(raw: string | undefined): string | null {
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
    return raw!;
  } catch {
    return null;
  }
}

export function safeMediaUrl(raw: string | undefined): string | null {
  const destination = safeDestinationUrl(raw);
  if (!destination) return null;
  try {
    const parsed = new URL(destination);
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

export class FeedContractError extends Error {
  constructor() {
    super('Feed response is incompatible with Garden Pins.');
    this.name = 'FeedContractError';
  }
}

/** Accept a canonical envelope while tolerating isolated bad entries. A
 * malformed envelope or a wholly legacy/non-Garden non-empty list is not an
 * authoritative empty collection and must never clear a valid cache. */
export function parsePinsEnvelope(data: unknown): PinItem[] {
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { items?: unknown }).items)) {
    throw new FeedContractError();
  }
  const items = (data as { items: unknown[] }).items;
  const pins = items.flatMap((value) => {
    const pin = normalizePinItem(value);
    return pin ? [pin] : [];
  });
  if (items.length > 0 && pins.length === 0) throw new FeedContractError();
  return pins;
}

/** Build a client bound to a config + fetch implementation for easy testing. */
export function createFeedClient(config: FeedConfig, fetchImpl: typeof fetch = fetch): FeedClient {
  const base = trimBase(config.baseUrl);
  const headers = buildHeaders(config.token);

  return {
    async fetchQueue(query) {
      const response = await fetchImpl(buildQueueUrl(base, query), { headers, redirect: 'error' });
      if (!response.ok) throw new Error(`Feed fetch failed: ${response.status}`);
      return parsePinsEnvelope(await response.json());
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
  return normaliseBundledConfig(await readBundledJson());
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

const ISO_UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

export function isCanonicalPinTimestamp(value: unknown): value is string {
  if (!isString(value)) return false;
  const match = ISO_UTC_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1] && Number.isFinite(Date.parse(value));
}

function normalizePinMedia(value: unknown): PinMedia | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const media = value as Record<string, unknown>;
  if ((media.kind !== 'image' && media.kind !== 'video') || !isString(media.url)) return undefined;
  const url = safeHttpUrl(media.url);
  if (!url) return undefined;
  const poster = isString(media.poster_url) ? safeHttpUrl(media.poster_url) : null;
  return {
    kind: media.kind,
    url,
    ...(poster ? { poster_url: poster } : {}),
  };
}

function normalizePinItem(value: unknown): PinItem | null {
  if (typeof value !== 'object' || value === null) return null;
  const pin = value as Record<string, unknown>;
  if (
    !isString(pin.id) || !pin.id.trim() ||
    !isString(pin.title) || !pin.title.trim() ||
    !isString(pin.url) || !safeDestinationUrl(pin.url) ||
    pin.source !== 'garden' ||
    !isCanonicalPinTimestamp(pin.pinned_at)
  ) {
    return null;
  }

  const media = normalizePinMedia(pin.media);
  const imageUrl = isString(pin.image_url) ? safeHttpUrl(pin.image_url) : null;
  return {
    id: pin.id.trim(),
    title: pin.title.trim(),
    url: pin.url.trim(),
    source: 'garden',
    pinned_at: pin.pinned_at,
    ...(media ? { media } : {}),
    ...(imageUrl ? { image_url: imageUrl } : {}),
  };
}

export async function loadCachedItems(): Promise<PinItem[]> {
  const stored = await browser.storage.local.get(CACHE_KEY);
  const cached = stored[CACHE_KEY];
  return Array.isArray(cached)
    ? cached.flatMap((value) => {
        const pin = normalizePinItem(value);
        return pin ? [pin] : [];
      })
    : [];
}

export async function saveCachedItems(items: PinItem[]): Promise<void> {
  const write = () => browser.storage.local.set({ [CACHE_KEY]: items });
  // Web Locks serialize cache ownership across React remounts and overlapping
  // extension-page contexts; the module-level writer handles in-context order.
  if (typeof navigator !== 'undefined' && navigator.locks) {
    await navigator.locks.request('marktab-pins-cache-v2-write', write);
    return;
  }
  await write();
}

export interface LatestCacheWriter {
  enqueue(items: PinItem[]): Promise<void>;
}

/** Serialize cache writes and coalesce queued snapshots. browser.storage writes
 * may resolve out of order when fired independently; this guarantees that the
 * final durable value is the newest requested projection. */
export function createLatestCacheWriter(
  write: (items: PinItem[]) => Promise<void> = saveCachedItems,
): LatestCacheWriter {
  type Snapshot = { version: number; items: PinItem[] };
  type Waiter = { version: number; resolve: () => void; reject: (error: unknown) => void };
  let latest: Snapshot | null = null;
  let running = false;
  let nextVersion = 0;
  const waiters: Waiter[] = [];

  const settleThrough = (version: number, error?: unknown) => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.version > version) continue;
      waiters.splice(index, 1);
      if (error === undefined) waiter.resolve();
      else waiter.reject(error);
    }
  };

  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (latest !== null) {
        const snapshot = latest;
        latest = null;
        try {
          await write(snapshot.items);
          settleThrough(snapshot.version);
        } catch (error) {
          // If a newer projection arrived while this write was pending, let it
          // satisfy both versions. Otherwise fail this bounded attempt.
          if (latest === null) settleThrough(snapshot.version, error);
        }
      }
    } finally {
      running = false;
      // Atomic ownership handoff: an enqueue at the drain/finalizer boundary
      // always starts a successor pump instead of stranding `latest`.
      if (latest !== null) void pump();
    }
  };

  return {
    enqueue(items) {
      const version = ++nextVersion;
      latest = { version, items: [...items] };
      const completion = new Promise<void>((resolve, reject) => {
        waiters.push({ version, resolve, reject });
      });
      void pump();
      return completion;
    },
  };
}
