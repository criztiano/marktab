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
import { faviconUrl } from './view-helpers';

export type TabsAvailability = 'checking' | 'needs-access' | 'enabling' | 'ready';

const REFRESH_DELAY_MS = 250;

/** Rows shown before "Show all": the heaviest few are what matters at a glance. */
export const TABS_COLLAPSED = 3;

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
  expanded?: boolean;
  onToggle?: () => void;
}

export function TabsView({ availability, usages, enable, close, focus, expanded = false, onToggle }: TabsViewProps) {
  if (availability === 'checking') return null;

  if (availability !== 'ready') {
    return (
      <section className="block tabs" aria-labelledby="tabs-title">
        <div className="block-head">
          <h2 className="block-title" id="tabs-title">
            Open tabs
          </h2>
        </div>
        <p className="block-note">
          <span>See which open tabs use the most memory, and close them.</span>
          <button
            type="button"
            className="text-button text-button--primary pressable"
            onClick={enable}
            disabled={availability === 'enabling'}
          >
            {availability === 'enabling' ? 'Enabling…' : 'Show tabs'}
          </button>
        </p>
      </section>
    );
  }

  const ranked = usages?.slice(0, TAB_LIMIT) ?? [];
  const shown = expanded ? ranked : ranked.slice(0, TABS_COLLAPSED);
  const heaviest = ranked[0]?.bytes ?? 1;
  const canToggle = ranked.length > TABS_COLLAPSED;

  return (
    <section className="block block--compact tabs" data-open="true" aria-labelledby="tabs-title" aria-busy={usages === null}>
      <div className="block-head">
        <h2 className="block-title" id="tabs-title">
          Open tabs by memory
        </h2>
        {expanded && usages && usages.length > TAB_LIMIT && (
          <span className="block-count">
            Top {TAB_LIMIT} of {usages.length}
          </span>
        )}
      </div>
      {usages && ranked.length === 0 && <p className="block-note">No open web pages to measure.</p>}
      <ol className="rows rows--compact" id="tabs-list">
        {shown.map((usage) => {
          const style = { '--share': usage.bytes / heaviest } as CSSProperties;
          return (
            <li key={usage.id} className="row tabs-row" style={style}>
              <button
                type="button"
                className="row-link pressable"
                title={`${usage.title}\n${usage.url}`}
                onClick={() => focus(usage)}
              >
                <img className="row-icon" src={faviconUrl(usage.url)} alt="" width={16} height={16} decoding="async" />
                <span className="row-text">
                  <span className="row-title">{usage.title}</span>
                </span>
                <span className="row-aside">{formatBytes(usage.bytes)}</span>
              </button>
              <button
                type="button"
                className="row-action pressable"
                aria-label={`Close ${usage.title}`}
                title="Close tab"
                onClick={(e) => {
                  // Keep keyboard focus in the list once this row is gone.
                  const row = e.currentTarget.closest('li');
                  const neighbour = row?.nextElementSibling ?? row?.previousElementSibling;
                  close(usage.id);
                  neighbour?.querySelector<HTMLButtonElement>('.row-action')?.focus();
                }}
              >
                ×
              </button>
            </li>
          );
        })}
      </ol>
      {canToggle && (
        <button
          type="button"
          className="text-button text-button--small pressable tabs-toggle"
          aria-expanded={expanded}
          aria-controls="tabs-list"
          onClick={onToggle}
        >
          {expanded ? 'Show fewer' : `Show all ${ranked.length}`}
        </button>
      )}
    </section>
  );
}

export default function Tabs() {
  const [expanded, setExpanded] = useState(false);
  return <TabsView {...useTabUsage()} expanded={expanded} onToggle={() => setExpanded((open) => !open)} />;
}
