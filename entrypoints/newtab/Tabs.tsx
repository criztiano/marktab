import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  TAB_LIMIT,
  closeTab,
  focusTab,
  formatBytes,
  hasTabAccess,
  loadTabUsage,
  requestTabAccess,
  type TabUsage,
} from './tab-usage';

export type TabsAvailability = 'checking' | 'needs-access' | 'enabling' | 'ready';

const REFRESH_DELAY_MS = 250;

function localFaviconUrl(pageUrl: string): string {
  return `chrome-extension://${browser.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=64`;
}

function useTabUsage() {
  const [availability, setAvailability] = useState<TabsAvailability>('checking');
  const [usages, setUsages] = useState<TabUsage[] | null>(null);
  const requestRef = useRef(0);

  // Latest refresh wins; an older, slower one never overwrites it.
  const refresh = useCallback(() => {
    const request = ++requestRef.current;
    void loadTabUsage()
      .then((next) => {
        if (request === requestRef.current) setUsages(next);
      })
      .catch(() => {
        if (request === requestRef.current) setUsages([]);
      });
  }, []);

  useEffect(() => {
    let active = true;
    void hasTabAccess()
      .then((granted) => active && setAvailability(granted ? 'ready' : 'needs-access'))
      .catch(() => active && setAvailability('needs-access'));
    const onRemoved = () => void hasTabAccess().then((granted) => !granted && setAvailability('needs-access'));
    browser.permissions.onRemoved.addListener(onRemoved);
    return () => {
      active = false;
      requestRef.current += 1;
      browser.permissions.onRemoved.removeListener(onRemoved);
    };
  }, []);

  // Re-measure when tabs change or this page comes back into view. Work only
  // while visible: the new tab page sits in the background most of the time.
  useEffect(() => {
    if (availability !== 'ready') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (document.hidden) return;
      clearTimeout(timer);
      timer = setTimeout(refresh, REFRESH_DELAY_MS);
    };
    const onUpdated = (_id: number, change: { status?: string }) => {
      if (change.status === 'complete') schedule();
    };
    refresh();
    const events = [browser.tabs.onCreated, browser.tabs.onRemoved, browser.tabs.onReplaced];
    events.forEach((e) => e.addListener(schedule));
    browser.tabs.onUpdated.addListener(onUpdated);
    document.addEventListener('visibilitychange', schedule);
    return () => {
      clearTimeout(timer);
      events.forEach((e) => e.removeListener(schedule));
      browser.tabs.onUpdated.removeListener(onUpdated);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [availability, refresh]);

  const enable = () => {
    setAvailability('enabling');
    // permissions.request stays the first async call so Chrome sees the click.
    requestTabAccess()
      .then((granted) => setAvailability(granted ? 'ready' : 'needs-access'))
      .catch(() => setAvailability('needs-access'));
  };

  // Drop the row at once; the next heaviest tab moves up into the list.
  const close = (id: number) => {
    setUsages((previous) => previous?.filter((usage) => usage.id !== id) ?? null);
    closeTab(id).catch(refresh);
  };

  const focus = (usage: TabUsage) => void focusTab(usage).catch(refresh);

  return { availability, usages, enable, close, focus };
}

interface TabsViewProps {
  availability: TabsAvailability;
  usages: TabUsage[] | null;
  enable: () => void;
  close: (id: number) => void;
  focus: (usage: TabUsage) => void;
}

export function TabsView({ availability, usages, enable, close, focus }: TabsViewProps) {
  if (availability === 'checking') return null;

  if (availability !== 'ready') {
    return (
      <section className="tabs" aria-label="Open tabs">
        <p className="pins-onboarding" role="status">
          <span>See which open tabs use the most memory, and close them.</span>
          <button type="button" onClick={enable} disabled={availability === 'enabling'}>
            {availability === 'enabling' ? 'Enabling…' : 'Show tabs'}
          </button>
        </p>
      </section>
    );
  }

  const shown = usages?.slice(0, TAB_LIMIT) ?? [];
  const heaviest = shown[0]?.bytes ?? 1;

  return (
    <section className="tabs" data-open="true" aria-labelledby="tabs-title">
      <h2 className="folder tabs-title" id="tabs-title">
        <span>Open tabs by memory</span>
        {usages && usages.length > TAB_LIMIT && (
          <span className="tabs-count">
            Top {TAB_LIMIT} of {usages.length}
          </span>
        )}
      </h2>
      {usages && shown.length === 0 && <p className="tabs-empty">No open web pages.</p>}
      <ol className="tabs-list">
        {shown.map((usage) => {
          const style = { '--share': usage.bytes / heaviest } as CSSProperties;
          return (
            <li key={usage.id} className="tabs-row" style={style}>
              <button
                type="button"
                className="tabs-open"
                title={`${usage.title}\n${usage.url}`}
                onClick={() => focus(usage)}
              >
                <img src={localFaviconUrl(usage.url)} alt="" width={16} height={16} />
                <span className="tabs-name">{usage.title}</span>
                <span className="tabs-mem">{formatBytes(usage.bytes)}</span>
              </button>
              <button
                type="button"
                className="tabs-close"
                aria-label={`Close ${usage.title}`}
                title="Close tab"
                onClick={(e) => {
                  // Keep keyboard focus in the list once this row is gone.
                  const row = e.currentTarget.closest('li');
                  const neighbour = row?.nextElementSibling ?? row?.previousElementSibling;
                  close(usage.id);
                  neighbour?.querySelector<HTMLButtonElement>('.tabs-close')?.focus();
                }}
              >
                ×
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default function Tabs() {
  return <TabsView {...useTabUsage()} />;
}
