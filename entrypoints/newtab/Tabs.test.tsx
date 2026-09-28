import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabsView, type TabsAvailability } from './Tabs';
import { formatBytes, isMeasurable, loadTabUsage, rankTabs, TAB_LIMIT, type TabUsage } from './tab-usage';
import { normaliseFolders } from './local-config';

const MB = 1024 ** 2;

function usage(id: number, bytes: number): TabUsage {
  return { id, windowId: 1, title: `Tab ${id}`, url: `https://site${id}.example/`, bytes };
}

function render(availability: TabsAvailability, usages: TabUsage[] | null = null) {
  return renderToStaticMarkup(
    <TabsView
      availability={availability}
      usages={usages}
      enable={vi.fn()}
      close={vi.fn()}
      focus={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal('browser', { runtime: { id: 'marktab-test-id' } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('tab usage helpers', () => {
  it('ranks heaviest first and keeps tab order on ties', () => {
    const ranked = rankTabs([usage(1, 5 * MB), usage(2, 90 * MB), usage(3, 5 * MB)]);
    expect(ranked.map((u) => u.id)).toEqual([2, 1, 3]);
  });

  it('formats memory for a quick glance', () => {
    expect(formatBytes(0.4 * MB)).toBe('<1 MB');
    expect(formatBytes(412.4 * MB)).toBe('412 MB');
    expect(formatBytes(1536 * MB)).toBe('1.5 GB');
  });

  it('measures only live web pages', () => {
    expect(isMeasurable({ id: 1, windowId: 1, url: 'https://a.example/' })).toBe(true);
    expect(isMeasurable({ id: 2, windowId: 1, url: 'http://localhost:3000/' })).toBe(true);
    expect(isMeasurable({ id: 3, windowId: 1, url: 'chrome://settings/' })).toBe(false);
    expect(isMeasurable({ id: 4, windowId: 1, url: 'https://a.example/', discarded: true })).toBe(false);
    expect(isMeasurable({ id: 5, windowId: 1 })).toBe(false);
  });
});

describe('loadTabUsage', () => {
  it('skips pages that fail, hang or report nothing, then ranks the rest', async () => {
    vi.useFakeTimers();
    const results: Record<number, () => Promise<unknown>> = {
      1: async () => [{ result: 20 * MB }],
      2: async () => {
        throw new Error('Cannot access contents of the page');
      },
      3: () => new Promise(() => {}), // frozen page never answers
      4: async () => [{ result: null }],
      5: async () => [{ result: 300 * MB }],
    };
    vi.stubGlobal('browser', {
      tabs: {
        query: async () => [
          ...[1, 2, 3, 4, 5].map((id) => ({ id, windowId: 1, title: `Tab ${id}`, url: `https://s${id}.example/` })),
          { id: 6, windowId: 1, title: 'New Tab', url: 'chrome://newtab/' },
        ],
      },
      scripting: {
        executeScript: ({ target }: { target: { tabId: number } }) => results[target.tabId](),
      },
    });

    const pending = loadTabUsage();
    await vi.advanceTimersByTimeAsync(2000);
    const ranked = await pending;
    expect(ranked.map((u) => [u.id, u.bytes])).toEqual([
      [5, 300 * MB],
      [1, 20 * MB],
    ]);
  });
});

describe('TabsView states', () => {
  it('renders nothing while permission is being checked', () => {
    expect(render('checking')).toBe('');
  });

  it('offers a one-click opt-in without host access', () => {
    const html = render('needs-access');
    expect(html).toContain('Show tabs');
    expect(html).not.toContain('data-open');
    expect(render('enabling')).toContain('disabled=""');
  });

  it(`lists only the top ${TAB_LIMIT} tabs with memory and a close button each`, () => {
    const usages = rankTabs(Array.from({ length: 15 }, (_, i) => usage(i + 1, (i + 1) * MB)));
    const html = render('ready', usages);
    expect(html).toContain('data-open="true"');
    expect(html).toContain(`Top ${TAB_LIMIT} of 15`);
    expect(html.match(/class="tabs-row"/g)).toHaveLength(TAB_LIMIT);
    expect(html).toContain('Close Tab 15');
    expect(html).not.toContain('Close Tab 3');
    expect(html).toContain('15 MB');
    expect(html).toContain('chrome-extension://marktab-test-id/_favicon/');
  });

  it('says so when no web pages are open', () => {
    expect(render('ready', [])).toContain('No open web pages.');
  });
});

describe('normaliseFolders', () => {
  it('reads an optional, case-insensitive folder list', () => {
    expect(normaliseFolders({ folders: [' Fun ', 7, ''] })).toEqual(new Set(['fun']));
    expect(normaliseFolders({ folders: [] })).toBeNull();
    expect(normaliseFolders({ baseUrl: 'https://pins.example' })).toBeNull();
    expect(normaliseFolders(null)).toBeNull();
  });
});
