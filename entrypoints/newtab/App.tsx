import { useEffect, useMemo, useRef, useState } from 'react';
import Pins from './Pins';
import Settings from './Settings';

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
  items: { id: string; title: string; url: string }[];
}

/** Root folders whose direct bookmarks we don't list (subfolders still show).
 *  Chrome ids: '1' = Bookmarks Bar. Add '2' (Other) or '3' (Mobile) to hide those too. */
const HIDDEN_ROOTS = new Set(['1']);

/** Chrome's local favicon cache — no network requests, needs "favicon" permission. */
function faviconUrl(pageUrl: string): string {
  return `chrome-extension://${browser.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=64`;
}

/** Wrap the first case-insensitive occurrence of `q` (already lowercased) in <mark>. */
function highlight(text: string, q: string) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q);
  if (i === -1) return text; // matched on URL, not title
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

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

export default function App() {
  const [sections, setSections] = useState<Section[]>([]);
  const [query, setQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0); // bump to re-fetch Pins after a config save
  const inputRef = useRef<HTMLInputElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () =>
      browser.bookmarks.getTree().then((tree) => setSections(flatten(tree as BookmarkNode[])));
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

  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q) return sections;
    return sections
      .map((s) => ({
        ...s,
        items: s.items.filter(
          (i) => i.title.toLowerCase().includes(q) || i.url.toLowerCase().includes(q),
        ),
      }))
      .filter((s) => s.items.length > 0);
  }, [sections, q]);

  const total = useMemo(() => sections.reduce((n, s) => n + s.items.length, 0), [sections]);
  const matches = useMemo(() => filtered.reduce((n, s) => n + s.items.length, 0), [filtered]);

  // Enter opens the first match in the current tab.
  const openFirst = () => {
    const first = filtered[0]?.items[0];
    if (first) window.location.href = first.url;
  };

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
      const links = Array.from(
        columnsRef.current?.querySelectorAll<HTMLAnchorElement>('.list a') ?? [],
      );
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
    if (!inSearch && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      input?.focus(); // keydown's default action then types into the input
    }
  };

  return (
    <main className="app" onKeyDown={onKeyDown}>
      <h1 className="sr-only">marktab</h1>
      <Settings onSaved={() => setReloadKey((k) => k + 1)} />
      <div className="search-bar" role="search">
        <input
          ref={inputRef}
          className="search"
          type="text"
          placeholder={`Search ${total} bookmarks…`}
          aria-label="Search bookmarks"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && openFirst()}
        />
        <p className="status" aria-live="polite">
          {q && `${matches} ${matches === 1 ? 'match' : 'matches'}`}
        </p>
      </div>
      {!q && <Pins key={reloadKey} />}
      {filtered.length === 0 && (
        <p className="empty">{total === 0 ? 'No bookmarks yet.' : 'Nothing matches.'}</p>
      )}
      <div className="columns" ref={columnsRef}>
        {filtered.map((section) => (
          <section key={section.id} className="column">
            <h2 className="folder">{section.path}</h2>
            <ul className="list">
              {section.items.map((item) => (
                <li key={item.id}>
                  <a href={item.url} title={`${item.title}\n${item.url}`}>
                    <img src={faviconUrl(item.url)} alt="" width={16} height={16} loading="lazy" />
                    <span>{highlight(item.title, q)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
