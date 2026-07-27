/** Version embedded in this new-tab bundle. Keep it in step with package.json. */
export const BUNDLE_VERSION = '0.1.1';

interface RuntimeVersionApi {
  getManifest(): { version: string };
  reload(): void;
}

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

let reloadRequested = false;

/** Reload runtime metadata once when Chrome serves newer cached new-tab assets
 * before noticing the unpacked manifest update. */
export function reloadForNewerBundle(
  runtime: RuntimeVersionApi,
  bundleVersion = BUNDLE_VERSION,
): boolean {
  if (reloadRequested || !isVersionNewer(bundleVersion, runtime.getManifest().version)) return false;
  reloadRequested = true;
  runtime.reload();
  return true;
}
