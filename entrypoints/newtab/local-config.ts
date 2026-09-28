// Private unpacked builds bundle `marktab-local.json` (see scripts/configure-unpacked.mjs).
// Generic public builds have no such file, so every reader falls back to null.

const LOCAL_CONFIG_FILE = 'marktab-local.json';

export async function readBundledJson(): Promise<unknown> {
  try {
    const url = new URL(LOCAL_CONFIG_FILE, browser.runtime.getURL('/')).href;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** Lowercased folder names to show, or null to show every folder. */
export function normaliseFolders(value: unknown): Set<string> | null {
  if (typeof value !== 'object' || value === null) return null;
  const folders = (value as Record<string, unknown>).folders;
  if (!Array.isArray(folders)) return null;
  const names = folders
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
}

export async function loadShownFolders(): Promise<Set<string> | null> {
  return normaliseFolders(await readBundledJson());
}
