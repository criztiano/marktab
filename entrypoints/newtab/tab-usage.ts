// Data layer for the "Open tabs" panel: which web pages hold the most memory.
//
// Stable Chrome gives extensions no per-tab process memory (chrome.processes is
// dev-channel only), so each page reports its own JavaScript heap through
// `performance.memory`. That figure ranks heavy tabs well but is lower than Task
// Manager (no images, media or GPU), is shared by same-site tabs in one process,
// and Chrome refreshes it at most every 20 minutes per process.

export interface TabUsage {
  id: number;
  windowId: number;
  title: string;
  url: string;
  bytes: number;
}

/** Minimal local shape — avoids depending on polyfill type exports. */
export interface TabLike {
  id?: number;
  windowId: number;
  title?: string;
  url?: string;
  discarded?: boolean;
}

export const TAB_LIMIT = 12;

/** Every web page, so the panel can read titles and measure memory. Requested
 * at runtime from the panel's button, never at install. */
export const TAB_ORIGINS = ['https://*/*', 'http://*/*'];

const MEASURE_TIMEOUT_MS = 1500;

/** Only live web pages can be measured; discarded tabs already hold no memory. */
export function isMeasurable(tab: TabLike): tab is TabLike & { id: number; url: string } {
  return (
    typeof tab.id === 'number' &&
    !tab.discarded &&
    typeof tab.url === 'string' &&
    /^https?:\/\//.test(tab.url)
  );
}

/** Heaviest first; ties keep tab order so rows do not jump between refreshes. */
export function rankTabs(usages: TabUsage[]): TabUsage[] {
  return usages
    .map((usage, index) => ({ usage, index }))
    .sort((a, b) => b.usage.bytes - a.usage.bytes || a.index - b.index)
    .map(({ usage }) => usage);
}

export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  if (mb < 1) return '<1 MB';
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Runs inside the page: must stay self-contained. */
function readHeapSize(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize : null;
}

/** A frozen or still-loading page can hold the injection back; give up quickly. */
async function measureTab(tabId: number): Promise<number | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), MEASURE_TIMEOUT_MS));
  const measure = browser.scripting
    .executeScript({ target: { tabId }, func: readHeapSize })
    .then(([frame]) => (typeof frame?.result === 'number' ? frame.result : null))
    .catch(() => null);
  return Promise.race([measure, timeout]);
}

export async function loadTabUsage(): Promise<TabUsage[]> {
  const tabs = ((await browser.tabs.query({})) as TabLike[]).filter(isMeasurable);
  const sizes = await Promise.all(tabs.map((tab) => measureTab(tab.id)));
  const usages: TabUsage[] = [];
  tabs.forEach((tab, index) => {
    const bytes = sizes[index];
    if (bytes === null || bytes <= 0) return;
    usages.push({ id: tab.id, windowId: tab.windowId, title: tab.title || tab.url, url: tab.url, bytes });
  });
  return rankTabs(usages);
}

export function hasTabAccess(): Promise<boolean> {
  return browser.permissions.contains({ origins: TAB_ORIGINS });
}

/** Call first in a click handler so Chrome sees the user gesture. */
export function requestTabAccess(): Promise<boolean> {
  return browser.permissions.request({ origins: TAB_ORIGINS });
}

export async function focusTab(tab: TabUsage): Promise<void> {
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
}

export function closeTab(tabId: number): Promise<void> {
  return browser.tabs.remove(tabId);
}
