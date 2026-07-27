import { describe, expect, it } from 'vitest';
import { normaliseLocalConfig, personaliseManifest } from './configure-unpacked.mjs';

describe('normaliseLocalConfig', () => {
  it('accepts apiKey or token without exposing either in the manifest', () => {
    expect(normaliseLocalConfig({ baseUrl: 'https://pins.example/api/', apiKey: 'placeholder' })).toEqual({
      baseUrl: 'https://pins.example/api/',
      token: 'placeholder',
    });
    expect(normaliseLocalConfig({ baseUrl: 'https://pins.example', token: 'placeholder-2' }).token).toBe(
      'placeholder-2',
    );
  });

  it.each([
    {},
    { baseUrl: 'http://pins.example', token: 'placeholder' },
    { baseUrl: 'http://localhost:3335', token: 'placeholder' },
    { baseUrl: 'https://pins.example', token: '' },
    { baseUrl: 'https://*.example', token: 'placeholder' },
  ])('rejects unsafe or incomplete input %#', (input) => {
    expect(() => normaliseLocalConfig(input)).toThrow();
  });
});

describe('personaliseManifest', () => {
  it('sets only the configured HTTPS origin as a required host permission', () => {
    const manifest = personaliseManifest(
      { manifest_version: 3, name: 'marktab', optional_host_permissions: ['https://*/*'] },
      { baseUrl: 'https://pins.example/api', token: 'placeholder' },
    );
    expect(manifest.host_permissions).toEqual(['https://pins.example/*']);
    expect(JSON.stringify(manifest)).not.toContain('placeholder');
  });
});
