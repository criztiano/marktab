/** Version embedded in this new-tab bundle. Keep it in step with package.json. */
export const BUNDLE_VERSION = '0.1.1';

interface RuntimeVersionApi {
  getManifest(): { version: string };
  reload(): void;
}

export interface ReloadSentinelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const RELOAD_SENTINEL_KEY = 'marktab.runtimeReloadPair';

function numericParts(version: string): number[] | null {
  if (!/^\d+(?:\.\d+)*$/.test(version)) return null;
  return version.split('.').map(Number);
}

export function isVersionNewer(candidate: string, current: string): boolean {
  const left = numericParts(candidate);
  const right = numericParts(current);
  if (!left || !right) return false;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** Reload runtime metadata once when Chrome serves newer cached new-tab assets
 * before noticing the unpacked manifest update. */
export function reloadForNewerBundle(
  runtime: RuntimeVersionApi,
  bundleVersion = BUNDLE_VERSION,
  storage: ReloadSentinelStorage = localStorage,
): boolean {
  const runtimeVersion = runtime.getManifest().version;
  if (!isVersionNewer(bundleVersion, runtimeVersion)) {
    try {
      storage.removeItem(RELOAD_SENTINEL_KEY);
    } catch {
      // A storage failure must not prevent the new-tab page from rendering.
    }
    return false;
  }

  const stalePair = JSON.stringify([runtimeVersion, bundleVersion]);
  try {
    if (storage.getItem(RELOAD_SENTINEL_KEY) === stalePair) return false;
    // Persist before reloading: the next document has a fresh module context.
    storage.setItem(RELOAD_SENTINEL_KEY, stalePair);
  } catch {
    // Without a durable sentinel, reloading could loop across fresh documents.
    return false;
  }

  runtime.reload();
  return true;
}
