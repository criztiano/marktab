import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  createFeedClient,
  hasHostAccess,
  loadCachedItems,
  loadConfig,
  requestHostAccess,
  safeHttpUrl,
  saveCachedItems,
  type FeedClient,
  type FeedConfig,
  type QueueItem,
} from './feed';

export type PinsAvailability = 'unconfigured' | 'needs-access' | 'enabling' | 'ready';

interface FeedQueueState {
  items: QueueItem[];
  failed: boolean;
  retrying: boolean;
  availability: PinsAvailability;
  dismiss: (id: string) => void;
  enable: () => void;
  markOpened: (id: string) => void;
  retry: () => void;
}

/** Keep the permissions request as the first async operation reached by the
 * button handler so Chrome can associate it with the user's click gesture. */
export function requestPinsAccess(
  baseUrl: string,
  request: (url: string) => Promise<boolean> = requestHostAccess,
): Promise<boolean> {
  return request(baseUrl);
}

/** Stale-while-revalidate. Unconfigured sources remain collapsed; configured
 * sources without access show a one-click permission onboarding state. */
function useFeedQueue(): FeedQueueState {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [availability, setAvailability] = useState<PinsAvailability>('unconfigured');
  const clientRef = useRef<FeedClient | null>(null);
  const configRef = useRef<FeedConfig | null>(null);
  const dismissedRef = useRef<Set<string>>(new Set());
  const hydratedRef = useRef(false);
  const mountedRef = useRef(false);
  const retryingRef = useRef(false);
  const enablingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (hydratedRef.current) void saveCachedItems(items);
  }, [items]);

  const keep = useCallback(
    (list: QueueItem[]) => list.filter((item) => !dismissedRef.current.has(item.id)),
    [],
  );

  const refresh = useCallback(
    async (isRetry: boolean) => {
      const client = clientRef.current;
      if (!client || retryingRef.current) return;
      if (isRetry) {
        retryingRef.current = true;
        if (mountedRef.current) setRetrying(true);
      }
      try {
        const fresh = await client.fetchQueue();
        if (!mountedRef.current) return;
        hydratedRef.current = true;
        setItems(keep(fresh));
        setFailed(false);
      } catch {
        if (mountedRef.current) setFailed(true); // keep cached cards visible
      } finally {
        if (isRetry) {
          retryingRef.current = false;
          if (mountedRef.current) setRetrying(false);
        }
      }
    },
    [keep],
  );

  const activate = useCallback(
    async (config: FeedConfig, showProgress: boolean) => {
      setFailed(false);
      let cached: QueueItem[] = [];
      try {
        cached = await loadCachedItems();
      } catch {
        // A damaged/missing cache must not block a live fetch after access is granted.
      }
      if (!mountedRef.current) return;
      if (cached.length) {
        hydratedRef.current = true;
        setItems(keep(cached));
      }
      clientRef.current = createFeedClient(config);
      if (!showProgress) setAvailability('ready');
      await refresh(false);
      if (showProgress && mountedRef.current) setAvailability('ready');
      enablingRef.current = false;
    },
    [keep, refresh],
  );

  useEffect(() => {
    void (async () => {
      let config: FeedConfig;
      try {
        config = await loadConfig();
      } catch {
        return;
      }
      if (!mountedRef.current || !config.baseUrl) return;
      configRef.current = config;
      let permitted = false;
      try {
        permitted = await hasHostAccess(config.baseUrl);
      } catch {
        // Treat an unavailable permission check like a missing grant: keep the
        // configured source visible and let the explicit click try again.
      }
      if (!permitted) {
        if (mountedRef.current) setAvailability('needs-access');
        return;
      }
      if (mountedRef.current) await activate(config, false);
    })();
  }, [activate]);

  const enable = () => {
    const config = configRef.current;
    if (!config || enablingRef.current) return;
    enablingRef.current = true;
    // Call immediately from the click handler; do not put storage/cache work first.
    const permission = requestPinsAccess(config.baseUrl);
    setAvailability('enabling');
    void permission
      .then((granted) => {
        if (!mountedRef.current) return;
        if (!granted) {
          enablingRef.current = false;
          setAvailability('needs-access');
          return;
        }
        void activate(config, true);
      })
      .catch(() => {
        enablingRef.current = false;
        if (mountedRef.current) setAvailability('needs-access');
      });
  };

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
    availability,
    dismiss,
    enable,
    markOpened,
    retry: () => void refresh(true),
  };
}

interface PinsViewProps {
  items: QueueItem[];
  failed: boolean;
  retrying: boolean;
  availability: PinsAvailability;
  dismiss: (id: string) => void;
  enable: () => void;
  markOpened: (id: string) => void;
  retry: () => void;
}

export function PinsView({
  items,
  failed,
  retrying,
  availability,
  dismiss,
  enable,
  markOpened,
  retry,
}: PinsViewProps) {
  const safe = items.filter((item) => safeHttpUrl(item.url));
  const hasCards = safe.length > 0;
  const needsOnboarding = availability === 'needs-access' || availability === 'enabling';
  const showOnboarding = !hasCards && needsOnboarding;
  const isOpen = hasCards || failed || showOnboarding;

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
              {showOnboarding && (
                <p className="pins-onboarding" role="status">
                  <span>Pins is configured. Chrome needs access to that host.</span>
                  <button type="button" onClick={enable} disabled={availability === 'enabling'}>
                    {availability === 'enabling' ? 'Enabling…' : 'Enable Pins'}
                  </button>
                </p>
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
