import { useEffect, useState, type ReactNode } from 'react';
import Thumb from './Thumb';
import {
  edenItemUrl,
  feedErrorKind,
  fetchGardenSearch,
  type FeedConfig,
  type FeedErrorKind,
  type GardenSearchItem,
} from './feed';
import { displayHost, faviconUrl } from './view-helpers';

export const SEARCH_DEBOUNCE_MS = 200;

export interface Bookmark {
  id: string;
  title: string;
  url: string;
}

/** One search result row, whichever source it came from. */
export interface ResultRow {
  id: string;
  href: string;
  title: string;
  meta: string;
  favicon: string;
  image: string | null;
}

export interface GardenSearchState {
  /** The query these items answer; differs from the typed query while loading. */
  query: string;
  attempt: number;
  items: GardenSearchItem[];
  error: FeedErrorKind | null;
}

const IDLE: GardenSearchState = { query: '', attempt: 0, items: [], error: null };

/** Wrap the first case-insensitive occurrence of `q` (already lowercased) in <mark>. */
export function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q);
  if (i === -1) return text; // matched on URL or body, not title
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** Debounced Garden search. Each new query or retry aborts the request before
 * it, so the latest query always wins; earlier items stay until it answers. */
export function useGardenSearch(config: FeedConfig | null, q: string) {
  const [state, setState] = useState<GardenSearchState>(IDLE);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!config || !q) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchGardenSearch(config, q, controller.signal).then(
        (items) => {
          if (!controller.signal.aborted) setState({ query: q, attempt, items, error: null });
        },
        (error) => {
          if (!controller.signal.aborted) setState({ query: q, attempt, items: [], error: feedErrorKind(error) });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [config, q, attempt]);

  const loading = Boolean(config && q) && (state.query !== q || state.attempt !== attempt);
  return { ...state, loading, retry: () => setAttempt((n) => n + 1) };
}

export function gardenRows(items: GardenSearchItem[], baseUrl: string): ResultRow[] {
  return items.flatMap((item) => {
    const href = edenItemUrl(baseUrl, item.eden_path);
    if (!href) return [];
    return [
      {
        id: item.id,
        href,
        title: item.title,
        meta: item.url ? displayHost(item.url) : (item.type ?? 'Garden'),
        favicon: faviconUrl(item.url ?? href),
        image: item.image_url ?? null,
      },
    ];
  });
}

/** Local fallback: title/URL filter over the shown bookmarks, in order. */
export function bookmarkRows(bookmarks: Bookmark[], q: string): ResultRow[] {
  return bookmarks
    .filter((b) => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q))
    .map((b) => ({
      id: b.id,
      href: b.url,
      title: b.title,
      meta: displayHost(b.url) || b.url,
      favicon: faviconUrl(b.url),
      image: null,
    }));
}

const Garden = () => <span translate="no">Garden</span>;

const ERROR_COPY: Record<FeedErrorKind, ReactNode> = {
  offline: (
    <>
      Couldn’t reach <Garden />. Check your connection.
    </>
  ),
  auth: (
    <>
      <Garden /> didn’t accept the key. Check Settings.
    </>
  ),
  missing: (
    <>
      <Garden /> search isn’t available on this server yet.
    </>
  ),
  server: (
    <>
      <Garden /> search failed on the server.
    </>
  ),
};

const count = (n: number, one: string, many: string) =>
  `${new Intl.NumberFormat().format(n)} ${n === 1 ? one : many}`;

interface StatusInput {
  mode: 'garden' | 'bookmarks';
  q: string;
  rows: number;
  loading: boolean;
  error: FeedErrorKind | null;
}

/** The one line under the input, also announced politely. */
export function searchStatus({ mode, q, rows, loading, error }: StatusInput): ReactNode {
  if (!q) return null;
  if (mode === 'bookmarks') return rows === 0 ? `No bookmarks match “${q}”.` : count(rows, 'match', 'matches');
  if (error && !loading) return ERROR_COPY[error];
  if (loading) {
    return rows > 0 ? 'Searching…' : (
      <>
        Searching <Garden />…
      </>
    );
  }
  if (rows === 0) {
    return (
      <>
        Nothing in <Garden /> matches “{q}”.
      </>
    );
  }
  return count(rows, 'result', 'results');
}

interface SearchResultsProps {
  rows: ResultRow[];
  q: string;
  busy: boolean;
}

export function SearchResults({ rows, q, busy }: SearchResultsProps) {
  if (rows.length === 0) return null;
  return (
    <section className="results" aria-label="Search results" aria-busy={busy}>
      <ul className="rows">
        {rows.map((row) => (
          <li key={row.id} className="row">
            <a className="row-link pressable" href={row.href} title={`${row.title}\n${row.meta}`}>
              <Thumb favicon={row.favicon} image={row.image} shape="square" />
              <span className="row-text">
                <span className="row-title">{highlight(row.title, q)}</span>
                <span className="row-meta">{row.meta}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
