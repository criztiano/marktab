import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureUnpacked, normaliseLocalConfig } from './configure-unpacked.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

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

describe('configureUnpacked', () => {
  it('writes a private bundled config without changing the generic manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marktab-configure-'));
    temporaryDirectories.push(directory);
    const outputDir = join(directory, 'output');
    const configPath = join(directory, 'local.json');
    const manifestPath = join(outputDir, 'manifest.json');
    const manifest = `${JSON.stringify(
      {
        manifest_version: 3,
        name: 'marktab',
        optional_host_permissions: ['https://*/*', 'http://localhost/*'],
      },
      null,
      2,
    )}\n`;
    await mkdir(outputDir);
    await writeFile(configPath, JSON.stringify({ baseUrl: 'https://pins.example/api', apiKey: 'placeholder' }));
    await writeFile(manifestPath, manifest);
    await writeFile(join(outputDir, 'marktab-local.json'), 'stale', { mode: 0o644 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await configureUnpacked({ configPath, outputDir });

    expect(await readFile(manifestPath, 'utf8')).toBe(manifest);
    expect(JSON.parse(await readFile(join(outputDir, 'marktab-local.json'), 'utf8'))).toEqual({
      baseUrl: 'https://pins.example/api',
      token: 'placeholder',
    });
    expect((await stat(join(outputDir, 'marktab-local.json'))).mode & 0o777).toBe(0o600);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Preconfigured Pins');
    expect(output).toContain('Enable Pins');
    expect(output).not.toContain('placeholder');
  });
});
