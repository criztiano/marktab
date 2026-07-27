import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function permissionOrigin(baseUrl) {
  const parsed = new URL(baseUrl);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export function normaliseLocalConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('Local config must be an object.');
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const tokenSource = typeof input.apiKey === 'string' ? input.apiKey : input.token;
  const token = typeof tokenSource === 'string' ? tokenSource.trim() : '';
  if (!baseUrl || !token) throw new Error('Local config requires baseUrl and apiKey.');

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('Local config baseUrl must be an absolute URL.');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.hostname.includes('*')) {
    throw new Error('Local config baseUrl must use HTTPS and a specific host.');
  }
  return { baseUrl, token };
}

export function personaliseManifest(manifest, config) {
  return { ...manifest, host_permissions: [permissionOrigin(config.baseUrl)] };
}

export async function configureUnpacked({
  configPath = resolve(homedir(), '.config/marktab/local.json'),
  outputDir = resolve(projectRoot, '.output/chrome-mv3'),
} = {}) {
  const source = JSON.parse(await readFile(configPath, 'utf8'));
  const config = normaliseLocalConfig(source);
  const manifestPath = resolve(outputDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const personalised = personaliseManifest(manifest, config);

  await writeFile(manifestPath, `${JSON.stringify(personalised, null, 2)}\n`);
  await writeFile(resolve(outputDir, 'marktab-local.json'), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });

  // Safe operational output: origin and paths only, never the API key.
  console.log(`Configured unpacked build for ${permissionOrigin(config.baseUrl)}`);
  console.log(`Output: ${outputDir}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  configureUnpacked().catch((error) => {
    const message = error instanceof Error ? error.message : 'Unknown configuration error.';
    console.error(`Could not configure unpacked build: ${message}`);
    process.exitCode = 1;
  });
}
