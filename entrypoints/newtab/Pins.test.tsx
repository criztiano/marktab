import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PinsView,
  PinProjection,
  persistAuthoritativeProjection,
  pinImage,
  requestPinsAccess,
  type PinsAvailability,
} from './Pins';
import { verifyAndSavePinsConfig } from './Settings';
import type { FeedErrorKind, PinItem } from './feed';

const baseItem: PinItem = {
  id: 'pin-1',
  title: 'Garden pin',
  url: 'https://reading.example/article',
  source: 'garden',
  pinned_at: '2026-07-27T00:00:00.000Z',
};

function render({
  items = [],
  failed = false,
  errorKind = null,
  settled = true,
  showSkeleton = false,
  retrying = false,
  availability = 'ready',
}: {
  items?: PinItem[];
  failed?: boolean;
  errorKind?: FeedErrorKind | null;
  settled?: boolean;
  showSkeleton?: boolean;
  retrying?: boolean;
  availability?: PinsAvailability;
} = {}) {
  return renderToStaticMarkup(
    <PinsView
      items={items}
      failed={failed}
      errorKind={errorKind}
      settled={settled}
      showSkeleton={showSkeleton}
      retrying={retrying}
      availability={availability}
      unpin={vi.fn()}
      enable={vi.fn()}
      retry={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal('browser', { runtime: { id: 'marktab-test-id' } });
});

afterEach(() => vi.unstubAllGlobals());

describe('PinsView states', () => {
  it('invites a first note when no source is configured', () => {
    const html = render({ availability: 'unconfigured' });
    expect(html).toContain('+ Note');
    expect(html).toContain('Add a note or quote to keep it in view.');
    expect(html).not.toContain('Enable Pins');
    expect(html).not.toContain('Retry');
  });

  it('shows Enable Pins for a configured source without host access', () => {
    const html = render({ availability: 'needs-access' });
    expect(html).toContain('Chrome needs access to that host.');
    expect(html).toContain('Enable Pins');
  });

  it('disables Enable Pins and announces progress while permission is pending', () => {
    const html = render({ availability: 'enabling' });
    expect(html).toContain('disabled=""');
    expect(html).toContain('Enabling…');
  });

  it('shows a static skeleton only once the first load is slow', () => {
    expect(render({ settled: false })).not.toContain('row--skeleton');
    const slow = render({ settled: false, showSkeleton: true });
    expect(slow.match(/row--skeleton/g)).toHaveLength(3);
    expect(slow).not.toContain('Nothing pinned yet');
  });

  it('says what belongs here when the source has no pins', () => {
    expect(render()).toContain('Nothing pinned yet.');
  });

  it('names the cause, offers retry and keeps stale rows visible', () => {
    const empty = render({ failed: true, errorKind: 'auth' });
    expect(empty).toContain('Pins couldn’t load. The server didn’t accept the key. Check Settings.');
    const stale = render({ items: [baseItem], failed: true, errorKind: 'offline', retrying: true });
    expect(stale).toContain('Garden pin');
    expect(stale).toContain('Couldn’t refresh Pins. Couldn’t reach the server.');
    expect(stale).toContain('Retrying…');
    expect(stale).not.toContain('Nothing pinned yet');
  });
});

describe('vertical pin rows', () => {
  it('renders a lazy 16:9 still, title, muted host and an explicit unpin only', () => {
    const publicImage = 'https://opengraph.githubassets.com/hash/example/repo';
    const richItem = {
      ...baseItem,
      url: 'https://www.reading.example/article',
      media: { kind: 'image' as const, url: publicImage },
      description: 'NEVER_RENDER_DESCRIPTION',
      author: 'NEVER_RENDER_AUTHOR',
    } as PinItem;
    const html = render({ items: [richItem] });

    expect(html).toContain(`src="${publicImage}"`);
    expect(html).toContain('class="thumb thumb--wide"');
    expect(html).toContain('width="96" height="54"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('crossorigin="anonymous"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('<span class="row-title row-title--clamp">Garden pin</span>');
    expect(html).toContain('<span class="row-meta">reading.example</span>');
    expect(html).toContain('aria-label="Unpin Garden pin"');
    expect(html).not.toContain('NEVER_RENDER_DESCRIPTION');
    expect(html).not.toContain('NEVER_RENDER_AUTHOR');
    expect(html).not.toContain('/opened');
  });

  it('shows a video as its poster still, never a playing video', () => {
    const video = 'https://video.twimg.com/ext_tw_video/example/pu/vid/avc1/clip.mp4';
    const poster = 'https://pbs.twimg.com/ext_tw_video_thumb/example/pu/img/poster.jpg';
    const html = render({
      items: [{ ...baseItem, media: { kind: 'video', url: video, poster_url: poster } }],
    });

    expect(html).not.toContain('<video');
    expect(html).not.toContain(video);
    expect(html).toContain(`src="${poster}"`);
  });

  it('picks image, then poster, then the image_url alias', () => {
    const image = 'https://pbs.twimg.com/media/alias.jpg';
    expect(pinImage({ ...baseItem, image_url: image })).toBe(image);
    expect(
      pinImage({ ...baseItem, media: { kind: 'video', url: 'https://video.twimg.com/a.mp4' }, image_url: image }),
    ).toBe(image);
    expect(pinImage(baseItem)).toBeNull();
  });

  it('suppresses unsafe/protected media and keeps the local-favicon placeholder', () => {
    const protectedMedia = 'https://eden.example/api/garden/media/private-id';
    const html = render({
      items: [{ ...baseItem, media: { kind: 'image', url: protectedMedia } }],
    });

    expect(html).not.toContain(protectedMedia);
    expect(html).toContain('class="thumb-icon"');
    expect(html).toContain('chrome-extension://marktab-test-id/_favicon/');
    expect(html).toContain('pageUrl=https%3A%2F%2Freading.example%2Farticle');
  });
});

describe('optimistic unpin projection', () => {
  it('rolls back a failed unpin and invalidates refreshes that observed temporary suppression', () => {
    const projection = new PinProjection();
    expect(projection.isAuthoritative()).toBe(true);
    const ticket = projection.beginUnpin(baseItem, 0);
    expect(projection.isAuthoritative()).toBe(false);
    const overlapping = projection.beginRefresh();
    expect(projection.project(overlapping, [baseItem])).toEqual([]);

    expect(projection.rollbackUnpin(ticket, [])).toEqual([baseItem]);
    expect(projection.isAuthoritative()).toBe(true);
    expect(projection.project(overlapping, [])).toBeNull();
  });

  it('suppresses stale refresh results until a post-mutation response confirms absence', () => {
    const projection = new PinProjection();
    const stale = projection.beginRefresh();
    const ticket = projection.beginUnpin(baseItem, 0);
    expect(projection.confirmUnpin(ticket)).toBe(true);
    expect(projection.isAuthoritative()).toBe(false);
    expect(projection.project(stale, [baseItem])).toEqual([]);

    const confirming = projection.beginRefresh();
    expect(projection.project(confirming, [])).toEqual([]);
    expect(projection.isAuthoritative()).toBe(true);
    const later = projection.beginRefresh();
    expect(projection.project(later, [baseItem])).toEqual([baseItem]);
  });

  it('never persists a provisional removal and resumes writes after rollback or confirmed absence', async () => {
    const projection = new PinProjection();
    const enqueue = vi.fn(async () => {});
    const writer = { enqueue };
    const ticket = projection.beginUnpin(baseItem, 0);

    expect(persistAuthoritativeProjection(projection, writer, [])).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();

    const restored = projection.rollbackUnpin(ticket, []);
    await persistAuthoritativeProjection(projection, writer, restored);
    expect(enqueue).toHaveBeenLastCalledWith([baseItem]);

    const successful = projection.beginUnpin(baseItem, 0);
    projection.confirmUnpin(successful);
    expect(persistAuthoritativeProjection(projection, writer, [])).toBeNull();
    const confirming = projection.beginRefresh();
    expect(projection.project(confirming, [])).toEqual([]);
    await persistAuthoritativeProjection(projection, writer, []);
    expect(enqueue).toHaveBeenLastCalledWith([]);
  });
});

describe('Settings verification ordering', () => {
  it('does not persist or report success when feed verification rejects', async () => {
    const incompatibility = new Error('Feed response is incompatible with Garden Pins.');
    const fetchItems = vi.fn().mockRejectedValue(incompatibility);
    const persist = vi.fn();
    await expect(
      verifyAndSavePinsConfig({ baseUrl: 'https://pins.example', token: '' }, fetchItems, persist),
    ).rejects.toBe(incompatibility);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('requestPinsAccess', () => {
  it('requests exactly the configured host and returns Chrome’s decision', async () => {
    const request = vi.fn().mockResolvedValue(false);
    const pending = requestPinsAccess('https://pins.example/api', request);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('https://pins.example/api');
    await expect(pending).resolves.toBe(false);
  });
});

describe('PinsView notes', () => {
  it('lists notes first as compact highlighter rows with an attribution', () => {
    const html = renderToStaticMarkup(
      <PinsView
        items={[baseItem]}
        failed={false}
        retrying={false}
        availability="ready"
        unpin={vi.fn()}
        enable={vi.fn()}
        retry={vi.fn()}
        notes={[
          { id: 'n1', text: 'Done is NOT Good' },
          { id: 'n2', text: 'Less, but better', by: 'Dieter Rams', color: 'pink' },
        ]}
      />,
    );
    expect(html.indexOf('Done is NOT Good')).toBeLessThan(html.indexOf('Garden pin'));
    expect(html).toContain('<p class="note-text"><mark>Done is NOT Good</mark></p>');
    expect(html).toContain('data-size="lg"');
    expect(html).toMatch(/<blockquote class="note-text"><mark>“(<!-- -->)?Less, but better(<!-- -->)?”<\/mark><\/blockquote>/);
    expect(html).toMatch(/note-by">— (<!-- -->)?Dieter Rams/);
    expect(html).toContain('aria-label="Remove note: Done is NOT Good"');
    expect(html).toContain('+ Note');
    expect(html).toContain('--note-mark:#ccff3d');
    expect(html).toContain('--note-mark:#ff7ad9');
    expect(html.match(/class="note-dot"/g)).toHaveLength(10);
    expect(html).toContain('aria-label="pink" aria-pressed="true"');
    expect(html).not.toContain('Add a note or quote');
  });
});
