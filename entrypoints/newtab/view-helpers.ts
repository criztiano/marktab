// Small helpers shared by the new-tab blocks (search, bookmarks, Pins, Review, tabs).

import { useEffect, useState } from 'react';

/** Chrome's local favicon cache — no network requests, needs "favicon" permission. */
export function faviconUrl(pageUrl: string): string {
  return `chrome-extension://${browser.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=64`;
}

/** "example.com" for row meta; empty when the URL does not parse. */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Compact age for dense rows: "now", "5m", "1h", "2d", "3w", "4mo", "1y".
 * A future timestamp (clock skew) reads "now", never "in 2m". */
export function formatCompactAge(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, (now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.max(1, Math.floor(days / 30))}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** True only once `active` has held for `delayMs`: skeletons never flash for fast loads. */
export function useDelayedFlag(active: boolean, delayMs = 300): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return shown;
}
