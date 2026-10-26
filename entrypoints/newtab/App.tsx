import { useEffect, useMemo, useRef, useState } from 'react';
import { BookmarksView } from './Bookmarks';
import Pins from './Pins';
import Review from './Review';
import {
  SearchResults,
  bookmarkRows,
  gardenRows,
  searchStatus,
  useGardenSearch,
  type Bookmark,
} from './Search';
import Settings from './Settings';
import Tabs from './Tabs';
import { useGardenSource } from './garden-source';
import { loadShownFolders } from './local-config';

// Minimal local type — avoids depending on polyfill type exports.
interface BookmarkNode {
  id: string;
  title: string;
  url?: string;
  children?: BookmarkNode[];
}

interface Section {
  id: string;
  /** Folder name */
  path: string;
  items: Bookmark[];
}

/** Root folders whose direct bookmarks we don't list (subfolders still show).
 *  Chrome ids: '1' = Bookmarks Bar. Add '2' (Other) or '3' (Mobile) to hide those too. */
const HIDDEN_ROOTS = new Set(['1']);

/** Walk the bookmark tree, emit one section per folder that directly contains bookmarks. */
function flatten(nodes: BookmarkNode[]): Section[] {
  const sections: Section[] = [];
  for (const node of nodes) {
    if (node.url) continue; // handled by parent folder below
    const items = (node.children ?? [])
      .filter((c) => c.url)
      .map((c) => ({ id: c.id, title: c.title || c.url!, url: c.url! }));
    if (items.length > 0 && !HIDDEN_ROOTS.has(node.id)) {
      sections.push({ id: node.id, path: node.title || 'Bookmarks', items });
    }
    const subfolders = (node.children ?? []).filter((c) => !c.url);
    sections.push(...flatten(subfolders));
  }
  return sections;
}

/** Keep only the configured folders; if none of them exist, show everything. */
function pickFolders(sections: Section[], shown: Set<string> | null): Section[] {
  if (!shown) return sections;
  const picked = sections.filter((s) => shown.has(s.path.toLowerCase()));
  return picked.length > 0 ? picked : sections;
}

export default function App() {
  const [sections, setSections] = useState<Section[] | null>(null);
  const [query, setQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0); // bump to re-read the source after a config save
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const openWhenReady = useRef(false);

  useEffect(() => {
    const shown = loadShownFolders(); // read once, before the first paint of sections
    const load = () =>
      Promise.all([browser.bookmarks.getTree(), shown]).then(([tree, folders]) =>
        setSections(pickFolders(flatten(tree as BookmarkNode[]), folders)),
      );
    load();
    // Stay in sync with Chrome's bookmarks while the tab is open.
    const events = [
      browser.bookmarks.onCreated,
      browser.bookmarks.onRemoved,
      browser.bookmarks.onChanged,
      browser.bookmarks.onMoved,
    ];
    events.forEach((e) => e.addListener(load));
    return () => events.forEach((e) => e.removeListener(load));
  }, []);

  const bookmarks = useMemo(() => (sections ?? []).flatMap((s) => s.items), [sections]);

  // Garden search when a source is configured and granted; otherwise bookmarks.
  const source = useGardenSource(reloadKey);
  const garden = source.status === 'ready' ? source.config : null;
  const term = query.trim();
  const q = term.toLowerCase();
  const search = useGardenSearch(garden, term);
  const rows = useMemo(
    () => (garden ? gardenRows(search.items, garden.baseUrl) : q ? bookmarkRows(bookmarks, q) : []),
    [garden, search.items, bookmarks, q],
  );
  const loading = garden ? search.loading : false;
  const shownRows = garden && search.error && !loading ? [] : rows;

  const firstLink = () => resultsRef.current?.querySelector<HTMLAnchorElement>('a');

  // Enter opens the first result in the current tab; while Garden is still
  // answering, it opens the first result of the query that was typed.
  const openFirst = () => {
    if (loading) {
      openWhenReady.current = true;
      return;
    }
    const first = firstLink();
    if (first) window.location.href = first.href;
  };

  useEffect(() => {
    if (loading || !openWhenReady.current) return;
    openWhenReady.current = false;
    const first = firstLink();
    if (first) window.location.href = first.href;
  }, [loading]);

  useEffect(() => {
    openWhenReady.current = false; // a new query cancels a pending Enter
  }, [term]);

  // Arrow keys move real focus between the search input and result links;
  // Esc clears; typing from anywhere lands in the search box.
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const input = inputRef.current;
    if (e.key === 'Escape') {
      setQuery('');
      input?.focus();
      return;
    }
    const inSearch = e.target === input;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const links = Array.from(resultsRef.current?.querySelectorAll<HTMLAnchorElement>('a') ?? []);
      if (links.length === 0) return;
      let next: HTMLElement | null = null;
      if (inSearch) {
        if (e.key === 'ArrowDown') next = links[0];
      } else {
        const i = links.indexOf(e.target as HTMLAnchorElement);
        if (i !== -1) next = e.key === 'ArrowDown' ? (links[i + 1] ?? null) : (links[i - 1] ?? input);
      }
      if (next) {
        e.preventDefault();
        next.focus();
      }
      return;
    }
    const pressesButton = e.key === ' ' && e.target instanceof HTMLButtonElement;
    const inField = e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLInputElement && !inSearch);
    if (!inSearch && !inField && !pressesButton && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      input?.focus(); // keydown's default action then types into the input
    }
  };

  const status = searchStatus({
    mode: garden ? 'garden' : 'bookmarks',
    q: term,
    rows: shownRows.length,
    loading,
    error: search.error,
  });
  const searching = term.length > 0;

  return (
    <main className="app" onKeyDown={onKeyDown}>
      <h1 className="sr-only" translate="no">
        marktab
      </h1>
      <Settings onSaved={() => setReloadKey((k) => k + 1)} />
      <div className="search-bar" role="search">
        <input
          ref={inputRef}
          className="search"
          type="text"
          placeholder={garden ? 'Search Garden…' : source.status === 'checking' ? 'Search…' : 'Search bookmarks…'}
          aria-label={garden ? 'Search Garden' : 'Search bookmarks'}
          aria-describedby="search-status"
          autoComplete="off"
          spellCheck={false}
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && openFirst()}
        />
        <div className="search-status" data-error={(garden && search.error && !loading) || undefined}>
          <p id="search-status" role="status">
            {status}
          </p>
          {garden && search.error && !loading && (
            <button type="button" className="text-button pressable" onClick={search.retry}>
              Retry
            </button>
          )}
        </div>
      </div>
      <div ref={resultsRef}>
        {searching && <SearchResults rows={shownRows} q={q} busy={loading} />}
      </div>
      {/* Everything below stays mounted while searching, so Pins, Review and
          tab readings survive a quick search. */}
      <div className="home" hidden={searching}>
        <BookmarksView bookmarks={bookmarks} loaded={sections !== null} />
        <div className="dashboard">
          <div className="dashboard-main">
            <Pins key={reloadKey} />
          </div>
          <div className="dashboard-side">
            <Review key={reloadKey} source={source} />
            <Tabs />
          </div>
        </div>
      </div>
    </main>
  );
}
