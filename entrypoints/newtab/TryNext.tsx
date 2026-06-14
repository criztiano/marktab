import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  createFeedClient,
  hasHostAccess,
  loadCachedItems,
  loadConfig,
  safeHttpUrl,
  saveCachedItems,
  type FeedClient,
  type QueueItem,
} from './feed';

/** Load the "Try next" feed on mount, stale-while-revalidate: show cached items
 *  immediately (no skeleton), then refresh in the background. The section is
 *  supplementary, so any failure just keeps what we have (or stays collapsed). */
function useFeedQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const clientRef = useRef<FeedClient | null>(null);
  const dismissedRef = useRef<Set<string>>(new Set()); // dismissed this session
  const hydratedRef = useRef(false); // true once a real load has populated items

  // Single cache writer: persist whatever is shown after the first real load, so
  // the next open paints instantly. Keeping it here avoids side effects in setState.
  useEffect(() => {
    if (hydratedRef.current) void saveCachedItems(items);
  }, [items]);

  useEffect(() => {
    let alive = true;
    const keep = (list: QueueItem[]) => list.filter((i) => !dismissedRef.current.has(i.id));
    (async () => {
      // Dormant until a host is configured AND access to it has been granted —
      // check that first so we never paint stale cards from an inaccessible host.
      const config = await loadConfig();
      if (!alive || !config.baseUrl) return;
      if (!(await hasHostAccess(config.baseUrl)) || !alive) return;

      const cached = await loadCachedItems();
      if (alive && cached.length) {
        hydratedRef.current = true;
        setItems(keep(cached)); // instant, no skeleton flash
      }
      const client = createFeedClient(config);
      clientRef.current = client;
      try {
        const fresh = await client.fetchQueue();
        if (!alive) return;
        hydratedRef.current = true;
        setItems(keep(fresh)); // drop anything dismissed while this load was in flight
      } catch {
        // Offline / endpoint error: keep cached items, otherwise stay collapsed.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const dismiss = (id: string) => {
    dismissedRef.current.add(id); // so an in-flight refresh can't resurrect it
    setItems((prev) => prev.filter((i) => i.id !== id)); // optimistic; cache syncs via effect
    // Best-effort: a failed dismiss just means the item reappears on next load.
    clientRef.current?.dismiss(id).catch(() => {});
  };

  // Best-effort POST; swallow rejections so a failed callback on click-through
  // never surfaces as an unhandled rejection.
  const markOpened = (id: string) => {
    clientRef.current?.markOpened(id).catch(() => {});
  };

  return { items, dismiss, markOpened };
}

export default function TryNext() {
  const { items, dismiss, markOpened } = useFeedQueue();

  // Drop items whose URL isn't plain http(s) — they're remote-controlled and a
  // javascript:/data: href would execute in the privileged extension origin.
  const safe = items.filter((item) => safeHttpUrl(item.url));
  const hasCards = safe.length > 0;

  // The section stays mounted (at zero height when empty) so the height can
  // animate smoothly when cards first arrive — no layout jump.
  return (
    <section className="trynext" aria-label="Try next" aria-hidden={!hasCards} data-open={hasCards}>
      <div className="trynext-anim">
        <div className="trynext-clip">
          {hasCards && (
            <>
              <h2 className="trynext-title">Try next</h2>
              <ul className="trynext-row">
                {safe.map((item, i) => {
                  const image = safeHttpUrl(item.image_url);
                  // reason: CSS custom property (--i) isn't part of CSSProperties
                  const style = { '--i': i } as CSSProperties;
                  return (
                    <li key={item.id} className="trynext-card" style={style}>
                      <a
                        className="trynext-link"
                        href={item.url}
                        title={`${item.title}\n${item.url}`}
                        onClick={() => markOpened(item.id)}
                      >
                        {image && (
                          <img
                            className="trynext-img"
                            src={image}
                            alt=""
                            loading="lazy"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none'; // hide broken previews
                            }}
                          />
                        )}
                        <span className="trynext-card-title">{item.title}</span>
                        {(item.description || item.author) && (
                          <span className="trynext-meta">{item.description || item.author}</span>
                        )}
                      </a>
                      <button
                        type="button"
                        className="trynext-dismiss"
                        aria-label={`Dismiss ${item.title}`}
                        onClick={() => dismiss(item.id)}
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
