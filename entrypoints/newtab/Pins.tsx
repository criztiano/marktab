import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import {
  createFeedClient,
  hasHostAccess,
  loadCachedItems,
  loadConfig,
  requestHostAccess,
  safeHttpUrl,
  safeMediaUrl,
  saveCachedItems,
  type FeedClient,
  type FeedConfig,
  type PinItem,
  type PinMedia,
} from './feed';

export type PinsAvailability = 'unconfigured' | 'needs-access' | 'enabling' | 'ready';

interface FeedQueueState {
  items: PinItem[];
  failed: boolean;
  retrying: boolean;
  availability: PinsAvailability;
  unpin: (id: string) => void;
  enable: () => void;
  retry: () => void;
}

interface PlaybackPolicy {
  inView: boolean;
  reducedMotion: boolean;
  failed: boolean;
}

export function shouldPlayVideo({ inView, reducedMotion, failed }: PlaybackPolicy): boolean {
  return inView && !reducedMotion && !failed;
}

export function videoPreload(nearViewport: boolean): 'none' | 'metadata' {
  return nearViewport ? 'metadata' : 'none';
}

/** Omitting src (rather than relying on preload="none") is the network gate. */
export function videoSource(url: string, nearViewport: boolean): string | undefined {
  return nearViewport ? url : undefined;
}

/** Keep permissions.request as the first async operation reached by the button
 * so Chrome can associate it with the user's click gesture. */
export function requestPinsAccess(
  baseUrl: string,
  request: (url: string) => Promise<boolean> = requestHostAccess,
): Promise<boolean> {
  return request(baseUrl);
}

function localFaviconUrl(pageUrl: string): string {
  return `chrome-extension://${browser.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=64`;
}

function publicMedia(item: PinItem): PinMedia | null {
  const canonicalUrl = safeMediaUrl(item.media?.url);
  if (item.media && canonicalUrl) {
    return {
      kind: item.media.kind,
      url: canonicalUrl,
      ...(item.media.kind === 'video'
        ? { poster_url: safeMediaUrl(item.media.poster_url) ?? undefined }
        : {}),
    };
  }
  const compatibilityImage = safeMediaUrl(item.image_url);
  return compatibilityImage ? { kind: 'image', url: compatibilityImage } : null;
}

function useNearViewport(target: RefObject<HTMLElement>, enabled: boolean): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = target.current;
    if (!enabled || !element || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '240px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, near, target]);
  return near;
}

function useInView(target: RefObject<HTMLElement>, enabled: boolean): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = target.current;
    if (!enabled || !element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting && entry.intersectionRatio >= 0.5),
      { threshold: [0, 0.5] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, target]);
  return inView;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

function PinMediaPreview({ item }: { item: PinItem }) {
  const media = publicMedia(item);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const isVideo = media?.kind === 'video';
  const nearViewport = useNearViewport(containerRef, isVideo);
  const inView = useInView(containerRef, isVideo);
  const reducedMotion = useReducedMotion();

  useEffect(() => setFailed(false), [media?.url]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (shouldPlayVideo({ inView, reducedMotion, failed })) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [failed, inView, reducedMotion]);

  return (
    <span ref={containerRef} className="pins-media" aria-hidden="true">
      <span className="pins-media-fallback">
        <img
          src={localFaviconUrl(item.url)}
          alt=""
          width={40}
          height={40}
          loading="lazy"
          decoding="async"
        />
      </span>
      {media?.kind === 'image' && !failed && (
        <img
          className="pins-media-asset"
          src={media.url}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
      {media?.kind === 'video' && !failed && (
        <video
          ref={videoRef}
          className="pins-media-asset"
          src={videoSource(media.url, nearViewport)}
          poster={media.poster_url}
          muted
          loop
          playsInline
          preload={videoPreload(nearViewport)}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

/** Stale-while-revalidate with explicit host-access onboarding. */
function useFeedQueue(): FeedQueueState {
  const [items, setItems] = useState<PinItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [availability, setAvailability] = useState<PinsAvailability>('unconfigured');
  const clientRef = useRef<FeedClient | null>(null);
  const configRef = useRef<FeedConfig | null>(null);
  const unpinnedRef = useRef<Set<string>>(new Set());
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
    (list: PinItem[]) => list.filter((item) => !unpinnedRef.current.has(item.id)),
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
        if (mountedRef.current) setFailed(true);
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
      let cached: PinItem[] = [];
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
        // Keep onboarding visible and let the explicit click try again.
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

  const unpin = (id: string) => {
    unpinnedRef.current.add(id);
    setItems((previous) => previous.filter((item) => item.id !== id));
    clientRef.current?.unpin(id).catch(() => {});
  };

  return {
    items,
    failed,
    retrying,
    availability,
    unpin,
    enable,
    retry: () => void refresh(true),
  };
}

interface PinsViewProps {
  items: PinItem[];
  failed: boolean;
  retrying: boolean;
  availability: PinsAvailability;
  unpin: (id: string) => void;
  enable: () => void;
  retry: () => void;
}

export function PinsView({
  items,
  failed,
  retrying,
  availability,
  unpin,
  enable,
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
                    const style = { '--i': index } as CSSProperties;
                    return (
                      <li key={item.id} className="pins-card" style={style}>
                        <a className="pins-link" href={item.url} title={item.title}>
                          <PinMediaPreview item={item} />
                          <span className="pins-card-title">{item.title}</span>
                        </a>
                        <button
                          type="button"
                          className="pins-dismiss"
                          aria-label={`Unpin ${item.title}`}
                          onClick={() => unpin(item.id)}
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
