import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PinsView, requestPinsAccess, type PinsAvailability } from './Pins';
import type { QueueItem } from './feed';

const item: QueueItem = {
  id: 'pin-1',
  title: 'Cached pin',
  url: 'https://reading.example/article',
  source: 'test',
  queued_at: '2026-07-27T00:00:00.000Z',
  status: 'queued',
};

function render({
  items = [],
  failed = false,
  retrying = false,
  availability = 'ready',
}: {
  items?: QueueItem[];
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
      dismiss={vi.fn()}
      enable={vi.fn()}
      markOpened={vi.fn()}
      retry={vi.fn()}
    />,
  );
}

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
    expect(html).not.toContain('couldn’t');
  });

  it('disables Enable Pins and announces progress while permission is pending', () => {
    const html = render({ availability: 'enabling' });
    expect(html).toContain('disabled=""');
    expect(html).toContain('Enabling…');
  });

  it('shows a compact retry state when an available configured source fails', () => {
    const html = render({ failed: true });
    expect(html).toContain('aria-hidden="false"');
    expect(html).toContain('Pins couldn’t load.');
    expect(html).toContain('Retry');
  });

  it('keeps cached cards and adds a stale retry affordance after refresh failure', () => {
    const html = render({ items: [item], failed: true });
    expect(html).toContain('Cached pin');
    expect(html).toContain('Couldn’t refresh');
    expect(html).toContain('Retry');
  });

  it('disables retry and announces progress while retrying', () => {
    const html = render({ failed: true, retrying: true });
    expect(html).toContain('disabled=""');
    expect(html).toContain('Retrying…');
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
