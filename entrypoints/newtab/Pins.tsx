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

interface FeedQueueState {
  items: QueueItem[];
  failed: boolean;
  retrying: boolean;
  dismiss: (id: string) => void;
  markOpened: (id: string) => void;
  retry: () => void;
}

/** Stale-while-revalidate. Only a fetch failure from a configured, permitted
 * source becomes visible; dormant or unavailable sources remain collapsed. */
function useFeedQueue(): FeedQueueState {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const clientRef = useRef<FeedClient | null>(null);
  const retryRef = useRef<() => void>(() => {});
  const dismissedRef = useRef<Set<string>>(new Set());
  const hydratedRef = useRef(false);
  const retryingRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current) void saveCachedItems(items);
  }, [items]);

  useEffect(() => {
    let alive = true;
    const keep = (list: QueueItem[]) => list.filter((item) => !dismissedRef.current.has(item.id));

    const refresh = async (isRetry: boolean) => {
      const client = clientRef.current;
      if (!client || retryingRef.current) return;
      if (isRetry) {
        retryingRef.current = true;
        if (alive) setRetrying(true);
      }
      try {
        const fresh = await client.fetchQueue();
        if (!alive) return;
        hydratedRef.current = true;
        setItems(keep(fresh));
        setFailed(false);
      } catch {
        if (alive) setFailed(true); // keep cached cards visible
      } finally {
        if (isRetry) {
          retryingRef.current = false;
          if (alive) setRetrying(false);
        }
      }
    };

    retryRef.current = () => void refresh(true);
    void (async () => {
      const config = await loadConfig();
      if (!alive || !config.baseUrl) return;
      if (!(await hasHostAccess(config.baseUrl)) || !alive) return;

      const cached = await loadCachedItems();
      if (alive && cached.length) {
        hydratedRef.current = true;
        setItems(keep(cached));
      }
      clientRef.current = createFeedClient(config);
      await refresh(false);
    })();

    return () => {
      alive = false;
      retryRef.current = () => {};
    };
  }, []);

  const dismiss = (id: string) => {
    dismissedRef.current.add(id);
    setItems((previous) => previous.filter((item) => item.id !== id));
    clientRef.current?.dismiss(id).catch(() => {});
  };

  const markOpened = (id: string) => {
    clientRef.current?.markOpened(id).catch(() => {});
  };

  return {
    items,
    failed,
    retrying,
    dismiss,
    markOpened,
    retry: () => retryRef.current(),
  };
}

interface PinsViewProps {
  items: QueueItem[];
  failed: boolean;
  retrying: boolean;
  dismiss: (id: string) => void;
  markOpened: (id: string) => void;
  retry: () => void;
}

export function PinsView({
  items,
  failed,
  retrying,
  dismiss,
  markOpened,
  retry,
}: PinsViewProps) {
  const safe = items.filter((item) => safeHttpUrl(item.url));
  const hasCards = safe.length > 0;
  const isOpen = hasCards || failed;

  return (
    <section className="pins" aria-label="Pins" aria-hidden={!isOpen} data-open={isOpen}>
      <div className="pins-anim">
        <div className="pins-clip">
          {isOpen && (
            <>
              <h2 className="pins-title">Pins</h2>
              {hasCards && (
                <ul className="pins-row">
                  {safe.map((item, index) => {
                    const image = safeHttpUrl(item.image_url);
                    const style = { '--i': index } as CSSProperties;
                    return (
                      <li key={item.id} className="pins-card" style={style}>
                        <a
                          className="pins-link"
                          href={item.url}
                          title={`${item.title}\n${item.url}`}
                          onClick={() => markOpened(item.id)}
                        >
                          {image && (
                            <img
                              className="pins-img"
                              src={image}
                              alt=""
                              loading="lazy"
                              onError={(event) => {
                                event.currentTarget.style.display = 'none';
                              }}
                            />
                          )}
                          <span className="pins-card-title">{item.title}</span>
                          {(item.description || item.author) && (
                            <span className="pins-meta">{item.description || item.author}</span>
                          )}
                        </a>
                        <button
                          type="button"
                          className="pins-dismiss"
                          aria-label={`Dismiss ${item.title}`}
                          onClick={() => dismiss(item.id)}
                        >
                          ×
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {failed && (
                <p className={`pins-error${hasCards ? ' pins-error--stale' : ''}`} role="status">
                  <span>{hasCards ? 'Couldn’t refresh Pins.' : 'Pins couldn’t load.'}</span>
                  <button type="button" onClick={retry} disabled={retrying}>
                    {retrying ? 'Retrying…' : 'Retry'}
                  </button>
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export default function Pins() {
  return <PinsView {...useFeedQueue()} />;
}
