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

const AGE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['minute', 60],
  ['hour', 60],
  ['day', 24],
  ['week', 7],
  ['month', 4.35],
  ['year', 12],
];

/** "3 hr. ago", "yesterday" — through Intl, in the reader's locale. */
export function formatAge(iso: string, now = Date.now(), locale?: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  let value = Math.min(0, (Date.parse(iso) - now) / 60_000); // minutes; never "in 2 min."
  let unit: Intl.RelativeTimeFormatUnit = 'minute';
  for (let i = 0; i < AGE_STEPS.length - 1; i += 1) {
    const [, size] = AGE_STEPS[i + 1];
    if (Math.abs(value) < size) break;
    value /= size;
    unit = AGE_STEPS[i + 1][0];
  }
  return Math.abs(value) < 1 && unit === 'minute' ? format.format(0, 'second') : format.format(Math.round(value), unit);
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
