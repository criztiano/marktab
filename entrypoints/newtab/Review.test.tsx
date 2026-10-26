import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReviewView } from './Review';
import type { FeedErrorKind, ReviewSnapshot } from './feed';
import { formatAge } from './view-helpers';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const snapshot: ReviewSnapshot = {
  total: 14,
  items: [
    { id: 'r1', title: 'Draft about easing', summary: 'Springs vs curves', created_at: '2026-10-26T09:00:00.000Z' },
    { id: 'r2', title: 'Untitled clip', created_at: '2026-10-20T12:00:00.000Z' },
  ],
};

function render({
  data = null,
  error = null,
  loading = false,
  showSkeleton = false,
}: {
  data?: ReviewSnapshot | null;
  error?: FeedErrorKind | null;
  loading?: boolean;
  showSkeleton?: boolean;
} = {}) {
  return renderToStaticMarkup(
    <ReviewView
      reviewUrl="https://eden.test/review"
      snapshot={data}
      error={error}
      loading={loading}
      showSkeleton={showSkeleton}
      retry={vi.fn()}
      now={NOW}
    />,
  );
}

describe('ReviewView states', () => {
  it('lists waiting posts linking to the Review page, with summary and age', () => {
    const html = render({ data: snapshot });
    expect(html).toContain('Open Review (14)');
    expect(html.match(/href="https:\/\/eden.test\/review"/g)).toHaveLength(3);
    expect(html).toContain('<span class="row-title row-title--clamp">Draft about easing</span>');
    expect(html).toContain('<span class="row-meta">Springs vs curves</span>');
    expect(html).toContain('dateTime="2026-10-26T09:00:00.000Z"');
    expect(html).toContain(formatAge(snapshot.items[0].created_at, NOW));
  });

  it('shows nothing but the header while a fast first load runs, then a static skeleton', () => {
    const fast = render({ loading: true });
    expect(fast).toContain('Open Review<');
    expect(fast).not.toContain('row--skeleton');
    expect(render({ loading: true, showSkeleton: true }).match(/row--skeleton/g)).toHaveLength(3);
  });

  it('says when nothing is waiting, next to the Open Review link', () => {
    const html = render({ data: { total: 0, items: [] } });
    expect(html).toContain('Nothing waiting for review.');
    expect(html).toContain('Open Review (0)');
  });

  it('names the cause and offers retry; 404 says the server lacks Review', () => {
    expect(render({ error: 'missing' })).toContain('Review isn’t available on this server yet.');
    const auth = render({ error: 'auth' });
    expect(auth).toContain('Check Settings.');
    expect(auth).toContain('>Retry<');
    expect(render({ error: 'offline', loading: true })).toContain('Retrying…');
  });

  it('keeps cached posts visible when a refresh fails', () => {
    const html = render({ data: snapshot, error: 'server' });
    expect(html).toContain('Draft about easing');
    expect(html).toContain('Couldn’t refresh. Review failed to load on the server.');
  });
});

describe('formatAge', () => {
  it('steps through units in the given locale', () => {
    expect(formatAge('2026-10-26T11:59:40.000Z', NOW, 'en')).toBe('now');
    expect(formatAge('2026-10-26T11:15:00.000Z', NOW, 'en')).toBe('45 min. ago');
    expect(formatAge('2026-10-26T09:00:00.000Z', NOW, 'en')).toBe('3 hr. ago');
    expect(formatAge('2026-10-25T12:00:00.000Z', NOW, 'en')).toBe('yesterday');
    expect(formatAge('2026-10-12T12:00:00.000Z', NOW, 'en')).toBe('2 wk. ago');
    expect(formatAge('2026-10-26T12:30:00.000Z', NOW, 'en')).toBe('now'); // clock skew never reads "in …"
  });
});
