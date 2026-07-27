import { describe, expect, it, vi } from 'vitest';
import { isVersionNewer, reloadForNewerBundle } from './runtime-version';

describe('runtime version guard', () => {
  it('compares dotted numeric versions', () => {
    expect(isVersionNewer('0.1.1', '0.1.0')).toBe(true);
    expect(isVersionNewer('0.1.1', '0.1.1')).toBe(false);
    expect(isVersionNewer('0.1.1', '0.2.0')).toBe(false);
    expect(isVersionNewer('1.0.0', '0.99.99')).toBe(true);
  });

  it('reloads once when bundle assets are newer than runtime metadata', () => {
    const runtime = {
      getManifest: vi.fn(() => ({ version: '0.1.0' })),
      reload: vi.fn(),
    };
    expect(reloadForNewerBundle(runtime, '0.1.1')).toBe(true);
    expect(runtime.reload).toHaveBeenCalledOnce();
  });

  it('does not reload when runtime metadata is current', () => {
    const runtime = {
      getManifest: vi.fn(() => ({ version: '0.1.1' })),
      reload: vi.fn(),
    };
    expect(reloadForNewerBundle(runtime, '0.1.1')).toBe(false);
    expect(runtime.reload).not.toHaveBeenCalled();
  });
});
