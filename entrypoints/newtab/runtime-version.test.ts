import { describe, expect, it, vi } from 'vitest';
import { isVersionNewer, reloadForNewerBundle } from './runtime-version';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
    removeItem: vi.fn((key: string) => void values.delete(key)),
  };
}

describe('runtime version guard', () => {
  it('compares dotted numeric versions', () => {
    expect(isVersionNewer('0.1.1', '0.1.0')).toBe(true);
    expect(isVersionNewer('0.1.1', '0.1.1')).toBe(false);
    expect(isVersionNewer('0.1.1', '0.2.0')).toBe(false);
    expect(isVersionNewer('1.0.0', '0.99.99')).toBe(true);
  });

  it('bounds stale-pair reloads across fresh contexts and clears the sentinel when current', () => {
    const storage = memoryStorage();
    const firstContext = {
      getManifest: vi.fn(() => ({ version: '0.1.0' })),
      reload: vi.fn(),
    };
    expect(reloadForNewerBundle(firstContext, '0.1.1', storage)).toBe(true);
    expect(firstContext.reload).toHaveBeenCalledOnce();

    const freshContext = {
      getManifest: vi.fn(() => ({ version: '0.1.0' })),
      reload: vi.fn(),
    };
    expect(reloadForNewerBundle(freshContext, '0.1.1', storage)).toBe(false);
    expect(freshContext.reload).not.toHaveBeenCalled();

    const currentContext = {
      getManifest: vi.fn(() => ({ version: '0.1.1' })),
      reload: vi.fn(),
    };
    expect(reloadForNewerBundle(currentContext, '0.1.1', storage)).toBe(false);
    expect(currentContext.reload).not.toHaveBeenCalled();
    expect(storage.removeItem).toHaveBeenCalledOnce();

    const laterContext = {
      getManifest: vi.fn(() => ({ version: '0.1.1' })),
      reload: vi.fn(),
    };
    expect(reloadForNewerBundle(laterContext, '0.1.2', storage)).toBe(true);
    expect(laterContext.reload).toHaveBeenCalledOnce();
  });

  it('renders instead of risking a loop when the sentinel cannot be persisted', () => {
    const runtime = {
      getManifest: vi.fn(() => ({ version: '0.1.0' })),
      reload: vi.fn(),
    };
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('storage unavailable');
      }),
      removeItem: vi.fn(),
    };

    expect(reloadForNewerBundle(runtime, '0.1.1', storage)).toBe(false);
    expect(runtime.reload).not.toHaveBeenCalled();
  });
});
