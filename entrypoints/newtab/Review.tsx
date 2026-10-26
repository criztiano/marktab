import { useEffect, useState } from 'react';
import {
  feedErrorKind,
  fetchReview,
  loadCachedReview,
  reviewPageUrl,
  saveCachedReview,
  type FeedConfig,
  type FeedErrorKind,
  type ReviewSnapshot,
} from './feed';
import type { GardenSource } from './garden-source';
import { formatAge, useDelayedFlag } from './view-helpers';

/** Stale-while-revalidate: the cached list paints at once, the live one replaces it. */
function useReview(config: FeedConfig) {
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [error, setError] = useState<FeedErrorKind | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    if (attempt === 0) {
      // A late cache read never replaces a live answer that arrived first.
      void loadCachedReview().then(
        (cached) => alive && cached && setSnapshot((current) => current ?? cached),
        () => {},
      );
    }
    setLoading(true);
    fetchReview(config, controller.signal)
      .then((fresh) => {
        if (!alive) return;
        setSnapshot(fresh);
        setError(null);
        void saveCachedReview(fresh).catch(() => {});
      })
      .catch((reason) => alive && setError(feedErrorKind(reason)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
      controller.abort();
    };
  }, [config, attempt]);

  return { snapshot, error, loading, retry: () => setAttempt((n) => n + 1) };
}

const ERROR_COPY: Record<FeedErrorKind, string> = {
  offline: 'Couldn’t reach the server. Check your connection.',
  auth: 'The server didn’t accept the key. Check Settings.',
  missing: 'Review isn’t available on this server yet.',
  server: 'Review failed to load on the server.',
};

interface ReviewViewProps {
  reviewUrl: string;
  snapshot: ReviewSnapshot | null;
  error: FeedErrorKind | null;
  loading: boolean;
  showSkeleton: boolean;
  retry: () => void;
  now?: number;
}

export function ReviewView({ reviewUrl, snapshot, error, loading, showSkeleton, retry, now = Date.now() }: ReviewViewProps) {
  const items = snapshot?.items ?? [];
  const total = snapshot?.total;
  return (
    <section className="block" aria-labelledby="review-title" aria-busy={loading}>
      <div className="block-head">
        <h2 className="block-title" id="review-title">
          Review
        </h2>
        <a className="text-button pressable" href={reviewUrl}>
          {total === undefined ? 'Open Review' : `Open Review (${new Intl.NumberFormat().format(total)})`}
        </a>
      </div>
      {items.length > 0 && (
        <ul className="rows">
          {items.map((item) => (
            <li key={item.id} className="row">
              <a className="row-link pressable" href={reviewUrl} title={item.summary ? `${item.title}\n${item.summary}` : item.title}>
                <span className="row-text">
                  <span className="row-title row-title--clamp">{item.title}</span>
                  {item.summary && <span className="row-meta">{item.summary}</span>}
                </span>
                <time className="row-aside" dateTime={item.created_at} title={new Date(item.created_at).toLocaleString()}>
                  {formatAge(item.created_at, now)}
                </time>
              </a>
            </li>
          ))}
        </ul>
      )}
      {items.length === 0 && !snapshot && !error && showSkeleton && (
        <ul className="rows" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="row row--skeleton">
              <span className="skeleton-line" />
            </li>
          ))}
        </ul>
      )}
      {snapshot && items.length === 0 && !error && <p className="block-note">Nothing waiting for review.</p>}
      {error && (
        <p className="block-note block-note--error" role="status">
          <span>{snapshot ? `Couldn’t refresh. ${ERROR_COPY[error]}` : ERROR_COPY[error]}</span>
          <button type="button" className="text-button pressable" onClick={retry} disabled={loading}>
            {loading ? 'Retrying…' : 'Retry'}
          </button>
        </p>
      )}
    </section>
  );
}

function ReviewBlock({ config }: { config: FeedConfig }) {
  const review = useReview(config);
  const showSkeleton = useDelayedFlag(review.loading && !review.snapshot);
  return <ReviewView reviewUrl={reviewPageUrl(config.baseUrl)} showSkeleton={showSkeleton} {...review} />;
}

/** Posts waiting in Eden's Review page. Only with a granted source; the Pins
 * block already carries the Enable Pins prompt otherwise. */
export default function Review({ source }: { source: GardenSource }) {
  return source.status === 'ready' ? <ReviewBlock config={source.config} /> : null;
}
