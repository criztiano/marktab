import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReviewView } from './Review';
import { shouldPlayVideo, videoSource } from './ReviewMedia';
import type { FeedErrorKind, ReviewSnapshot } from './feed';
import { formatCompactAge } from './view-helpers';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const snapshot: ReviewSnapshot = {
  total: 14,
  items: [
    {
      id: 'r1',
      title: '@AristideBenoist',
      summary: 'Springs vs curves: which one should a calm UI use?',
      kind: 'post',
      created_at: '2026-10-26T09:00:00.000Z',
      media: { kind: 'image', url: 'https://pbs.twimg.com/media/still.jpg' },
    },
    { id: 'r2', title: 'Untitled clip', created_at: '2026-10-20T12:00:00.000Z' },
    {
      id: 'r3',
      title: '@motion',
      summary: 'A looping clip',
      created_at: '2026-10-26T11:58:00.000Z',
      media: {
        kind: 'video',
        url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/clip.mp4',
        poster_url: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/poster.jpg',
      },
    },
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
  it('leads with the post text, puts the author under it, and shows a compact age', () => {
    const html = render({ data: snapshot });
    expect(html).toContain('Open Review (14)');
    expect(html.match(/href="https:\/\/eden.test\/review"/g)).toHaveLength(4);
    expect(html).toMatch(
      /<span class="row-title row-title--clamp3">Springs vs curves: which one should a calm UI use\?<\/span><span class="row-meta">@AristideBenoist<\/span>/,
    );
    expect(html).toContain('dateTime="2026-10-26T09:00:00.000Z"');
    expect(html).toMatch(/dateTime="2026-10-26T09:00:00.000Z" title="[^"]+">3h<\/time>/);
  });

  it('shows text without a summary once, with no author line', () => {
    const html = render({ data: snapshot });
    expect(html).toContain('<span class="row-title row-title--clamp3">Untitled clip</span></span>');
    expect(html.match(/Untitled clip/g)).toHaveLength(2); // row text + title attribute
  });

  it('renders image media as a lazy 16:9 still and video with its poster but no source yet', () => {
    const html = render({ data: snapshot });
    expect(html).toContain('src="https://pbs.twimg.com/media/still.jpg"');
    expect(html).toContain('class="thumb thumb--wide"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('<video');
    expect(html).toContain('poster="https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/poster.jpg"');
    expect(html).not.toContain('clip.mp4');
    expect(html).toContain('muted=""');
    expect(html).toContain('loop=""');
    expect(html).toContain('playsinline=""');
    expect(html).toContain('preload="none"');
    expect(html).not.toContain('autoplay');
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
    expect(html).toContain('Springs vs curves');
    expect(html).toContain('Couldn’t refresh. Review failed to load on the server.');
  });
});

describe('video policy', () => {
  it('attaches the source only near the viewport and never under reduced motion', () => {
    const url = 'https://video.twimg.com/a.mp4';
    expect(videoSource(url, false, false)).toBeUndefined();
    expect(videoSource(url, true, false)).toBe(url);
    expect(videoSource(url, true, true)).toBeUndefined();
  });

  it('plays only in view, without reduced motion, and not after an error', () => {
    expect(shouldPlayVideo({ inView: true, reducedMotion: false, failed: false })).toBe(true);
    expect(shouldPlayVideo({ inView: false, reducedMotion: false, failed: false })).toBe(false);
    expect(shouldPlayVideo({ inView: true, reducedMotion: true, failed: false })).toBe(false);
    expect(shouldPlayVideo({ inView: true, reducedMotion: false, failed: true })).toBe(false);
  });
});

describe('formatCompactAge', () => {
  it.each([
    ['2026-10-26T11:59:40.000Z', 'now'],
    ['2026-10-26T12:30:00.000Z', 'now'], // clock skew never reads "in …"
    ['2026-10-26T11:55:00.000Z', '5m'],
    ['2026-10-26T11:00:00.000Z', '1h'],
    ['2026-10-24T11:00:00.000Z', '2d'],
    ['2026-10-05T12:00:00.000Z', '3w'],
    ['2026-06-20T12:00:00.000Z', '4mo'],
    ['2025-10-01T12:00:00.000Z', '1y'],
  ])('%s → %s', (iso, label) => {
    expect(formatCompactAge(iso, NOW)).toBe(label);
  });
});
