import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchResults, bookmarkRows, gardenRows, searchStatus } from './Search';
import type { FeedErrorKind, GardenSearchItem } from './feed';

const status = (input: Partial<Parameters<typeof searchStatus>[0]>) =>
  renderToStaticMarkup(
    <>{searchStatus({ mode: 'garden', q: 'ease', rows: 0, loading: false, error: null, ...input })}</>,
  );

const gardenItem: GardenSearchItem = {
  id: 'g1',
  title: 'Spring easing',
  url: 'https://www.example.com/post',
  eden_path: '/garden/g1',
  image_url: 'https://pbs.twimg.com/media/a.jpg',
};

beforeEach(() => {
  vi.stubGlobal('browser', { runtime: { id: 'marktab-test-id' } });
});

afterEach(() => vi.unstubAllGlobals());

describe('result rows', () => {
  it('links Garden items into Eden, with the source host as meta', () => {
    const [row] = gardenRows([gardenItem], 'https://eden.test/');
    expect(row).toMatchObject({
      href: 'https://eden.test/garden/g1',
      meta: 'example.com',
      image: 'https://pbs.twimg.com/media/a.jpg',
    });
    expect(row.favicon).toContain('pageUrl=https%3A%2F%2Fwww.example.com%2Fpost');
  });

  it('falls back to the item type, then "Garden", when there is no source URL', () => {
    const rows = gardenRows(
      [
        { id: 'a', title: 'A', url: null, eden_path: '/garden/a', type: 'instrument' },
        { id: 'b', title: 'B', url: null, eden_path: '/garden/b' },
        { id: 'c', title: 'C', url: null, eden_path: '//evil.example' },
      ],
      'https://eden.test',
    );
    expect(rows.map((r) => r.meta)).toEqual(['instrument', 'Garden']);
    expect(rows[1].favicon).toContain('pageUrl=https%3A%2F%2Feden.test%2Fgarden%2Fb');
  });

  it('filters bookmarks by title or URL and keeps their order', () => {
    const rows = bookmarkRows(
      [
        { id: '1', title: 'Linear', url: 'https://linear.app/' },
        { id: '2', title: 'Docs', url: 'https://example.com/linear-guide' },
        { id: '3', title: 'Mail', url: 'https://mail.example/' },
      ],
      'linear',
    );
    expect(rows.map((r) => r.id)).toEqual(['1', '2']);
    expect(rows[0]).toMatchObject({ href: 'https://linear.app/', meta: 'linear.app', image: null });
  });
});

describe('search status line', () => {
  it('is silent with no query', () => {
    expect(status({ q: '' })).toBe('');
  });

  it('counts bookmark matches or says nothing matches', () => {
    expect(status({ mode: 'bookmarks', rows: 1 })).toBe('1 match');
    expect(status({ mode: 'bookmarks', rows: 3 })).toBe('3 matches');
    expect(status({ mode: 'bookmarks', rows: 0 })).toBe('No bookmarks match “ease”.');
  });

  it('covers Garden loading, results and no results', () => {
    expect(status({ loading: true })).toBe('Searching <span translate="no">Garden</span>…');
    expect(status({ loading: true, rows: 4 })).toBe('Searching…');
    expect(status({ rows: 8 })).toBe('8 results');
    expect(status({ rows: 0 })).toBe('Nothing in <span translate="no">Garden</span> matches “ease”.');
  });

  it.each<[FeedErrorKind, string]>([
    ['missing', 'search isn’t available on this server yet.'],
    ['auth', 'didn’t accept the key. Check Settings.'],
    ['offline', 'Check your connection.'],
    ['server', 'search failed on the server.'],
  ])('names the %s cause', (error, copy) => {
    expect(status({ error })).toContain(copy);
    // A new query in flight replaces the old error with "Searching…".
    expect(status({ error, loading: true })).not.toContain(copy);
  });
});

describe('SearchResults', () => {
  it('renders nothing without rows', () => {
    expect(renderToStaticMarkup(<SearchResults rows={[]} q="x" busy={false} />)).toBe('');
  });

  it('renders real links with a square thumb and highlighted title', () => {
    const rows = gardenRows([gardenItem], 'https://eden.test');
    const html = renderToStaticMarkup(<SearchResults rows={rows} q="eas" busy />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('<a class="row-link pressable" href="https://eden.test/garden/g1"');
    expect(html).toContain('class="thumb thumb--square"');
    expect(html).toContain('width="32" height="32"');
    expect(html).not.toContain('loading="lazy"');
    expect(html).toContain('Spring <mark>eas</mark>ing');
    expect(html).toContain('<span class="row-meta">example.com</span>');
  });
});
