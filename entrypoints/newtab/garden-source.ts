// Whether the optional Garden source can be used right now: a base URL is
// configured and Chrome has granted that host. Search and Review follow it.

import { useEffect, useState } from 'react';
import { hasHostAccess, loadConfig, type FeedConfig } from './feed';

export type GardenSource =
  | { status: 'checking' }
  | { status: 'off' } // no base URL: public builds stay request-free
  | { status: 'needs-access'; config: FeedConfig }
  | { status: 'ready'; config: FeedConfig };

function sourceKey(source: GardenSource): string {
  return 'config' in source
    ? JSON.stringify([source.status, source.config.baseUrl, source.config.token])
    : source.status;
}

export async function readGardenSource(): Promise<GardenSource> {
  const config = await loadConfig();
  if (!config.baseUrl) return { status: 'off' };
  const granted = await hasHostAccess(config.baseUrl).catch(() => false);
  return granted ? { status: 'ready', config } : { status: 'needs-access', config };
}

/** Re-reads after a Settings save (`reloadKey`) and whenever host grants change,
 * so the Enable Pins click also switches Garden search and Review on. */
export function useGardenSource(reloadKey: number): GardenSource {
  const [source, setSource] = useState<GardenSource>({ status: 'checking' });
  useEffect(() => {
    let active = true;
    const read = () =>
      void readGardenSource().then(
        (next) => {
          if (!active) return;
          // Keep the same object while nothing changed so dependent fetches do not restart.
          setSource((previous) => (sourceKey(previous) === sourceKey(next) ? previous : next));
        },
        () => active && setSource({ status: 'off' }),
      );
    read();
    browser.permissions.onAdded.addListener(read);
    browser.permissions.onRemoved.addListener(read);
    return () => {
      active = false;
      browser.permissions.onAdded.removeListener(read);
      browser.permissions.onRemoved.removeListener(read);
    };
  }, [reloadKey]);
  return source;
}
