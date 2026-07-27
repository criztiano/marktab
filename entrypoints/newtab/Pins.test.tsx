import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PinsView } from './Pins';
import type { QueueItem } from './feed';

const item: QueueItem = {
  id: 'pin-1',
  title: 'Cached pin',
  url: 'https://reading.example/article',
  source: 'test',
  queued_at: '2026-07-27T00:00:00.000Z',
  status: 'queued',
};

function render(items: QueueItem[], failed: boolean, retrying = false) {
  return renderToStaticMarkup(
    <PinsView
      items={items}
      failed={failed}
      retrying={retrying}
      dismiss={vi.fn()}
      markOpened={vi.fn()}
      retry={vi.fn()}
    />,
  );
}

describe('PinsView failure states', () => {
  it('stays collapsed without an error for dormant or unavailable sources', () => {
    const html = render([], false);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('Retry');
    expect(html).not.toContain('couldn’t');
  });

  it('shows a compact retry state when an available configured source fails', () => {
    const html = render([], true);
    expect(html).toContain('aria-hidden="false"');
    expect(html).toContain('Pins couldn’t load.');
    expect(html).toContain('Retry');
  });

  it('keeps cached cards and adds a stale retry affordance after refresh failure', () => {
    const html = render([item], true);
    expect(html).toContain('Cached pin');
    expect(html).toContain('Couldn’t refresh');
    expect(html).toContain('Retry');
  });

  it('disables retry and announces progress while retrying', () => {
    const html = render([], true, true);
    expect(html).toContain('disabled=""');
    expect(html).toContain('Retrying…');
  });
});
