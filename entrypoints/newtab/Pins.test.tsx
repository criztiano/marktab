import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PinsView,
  requestPinsAccess,
  shouldPlayVideo,
  videoPreload,
  videoSource,
  type PinsAvailability,
} from './Pins';
import type { PinItem } from './feed';

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
  retrying = false,
  availability = 'ready',
}: {
  items?: PinItem[];
  failed?: boolean;
  retrying?: boolean;
  availability?: PinsAvailability;
} = {}) {
  return renderToStaticMarkup(
    <PinsView
      items={items}
      failed={failed}
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
  it('keeps an unconfigured source collapsed', () => {
    const html = render({ availability: 'unconfigured' });
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('Enable Pins');
    expect(html).not.toContain('Retry');
  });

  it('shows Enable Pins for a configured source without host access', () => {
    const html = render({ availability: 'needs-access' });
    expect(html).toContain('aria-hidden="false"');
    expect(html).toContain('Chrome needs access to that host.');
    expect(html).toContain('Enable Pins');
  });

  it('disables Enable Pins and announces progress while permission is pending', () => {
    const html = render({ availability: 'enabling' });
    expect(html).toContain('disabled=""');
    expect(html).toContain('Enabling…');
  });

  it('shows retry states and keeps stale cards visible', () => {
    expect(render({ failed: true })).toContain('Pins couldn’t load.');
    const stale = render({ items: [baseItem], failed: true, retrying: true });
    expect(stale).toContain('Garden pin');
    expect(stale).toContain('Couldn’t refresh');
    expect(stale).toContain('Retrying…');
  });
});

describe('media-first title-only cards', () => {
  it('renders a lazy async public image, reserved fallback art, title, and explicit unpin only', () => {
    const publicImage = 'https://opengraph.githubassets.com/hash/example/repo';
    const richItem = {
      ...baseItem,
      media: { kind: 'image' as const, url: publicImage },
      description: 'NEVER_RENDER_DESCRIPTION',
      author: 'NEVER_RENDER_AUTHOR',
    } as PinItem;
    const html = render({ items: [richItem] });

    expect(html).toContain(`src="${publicImage}"`);
    expect(html).toContain('class="pins-media"');
    expect(html).toContain('class="pins-media-fallback"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('Garden pin');
    expect(html).toContain('aria-label="Unpin Garden pin"');
    expect(html).not.toContain('NEVER_RENDER_DESCRIPTION');
    expect(html).not.toContain('NEVER_RENDER_AUTHOR');
    expect(html).not.toContain('/opened');
  });

  it('renders a public video poster without attaching its offscreen source', () => {
    const video = 'https://video.twimg.com/ext_tw_video/example/pu/vid/avc1/clip.mp4';
    const poster = 'https://pbs.twimg.com/ext_tw_video_thumb/example/pu/img/poster.jpg';
    const html = render({
      items: [{ ...baseItem, media: { kind: 'video', url: video, poster_url: poster } }],
    });

    expect(html).toContain('<video');
    expect(html).not.toContain(`src="${video}"`);
    expect(html).toContain(`poster="${poster}"`);
    expect(html).toContain('preload="none"');
    expect(html).toContain('loop=""');
    expect(html).toContain('playsinline=""');
    expect(html).not.toContain('autoplay');
  });

  it('supports the image_url compatibility alias when canonical media is absent', () => {
    const image = 'https://pbs.twimg.com/media/alias.jpg';
    const html = render({ items: [{ ...baseItem, image_url: image }] });
    expect(html).toContain(`src="${image}"`);
  });

  it('suppresses unsafe/protected media and keeps a 16:9 local-favicon fallback', () => {
    const protectedMedia = 'https://eden.example/api/garden/media/private-id';
    const html = render({
      items: [{ ...baseItem, media: { kind: 'image', url: protectedMedia } }],
    });

    expect(html).not.toContain(protectedMedia);
    expect(html).toContain('class="pins-media-fallback"');
    expect(html).toContain('chrome-extension://marktab-test-id/_favicon/');
    expect(html).toContain('pageUrl=https%3A%2F%2Freading.example%2Farticle');
  });
});

describe('video viewport policy', () => {
  it('attaches the source and upgrades preload only near the viewport', () => {
    const source = 'https://video.twimg.com/example.mp4';
    expect(videoSource(source, false)).toBeUndefined();
    expect(videoSource(source, true)).toBe(source);
    expect(videoPreload(false)).toBe('none');
    expect(videoPreload(true)).toBe('metadata');
  });

  it('plays only while visible and never under reduced motion or after failure', () => {
    expect(shouldPlayVideo({ inView: true, reducedMotion: false, failed: false })).toBe(true);
    expect(shouldPlayVideo({ inView: false, reducedMotion: false, failed: false })).toBe(false);
    expect(shouldPlayVideo({ inView: true, reducedMotion: true, failed: false })).toBe(false);
    expect(shouldPlayVideo({ inView: true, reducedMotion: false, failed: true })).toBe(false);
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
