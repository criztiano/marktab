import { chmod, readFile, writeFile } from 'node:fs/promises';
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
  // Optional: bookmark folder names the new tab shows (all folders when absent).
  const folders = Array.isArray(input.folders)
    ? input.folders.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim())
    : [];
  // Optional: starter notes for the Pins row — strings or { text, by }. They
  // seed local storage once; after that the new tab owns them.
  const notes = Array.isArray(input.notes)
    ? input.notes.flatMap((note) => {
        if (typeof note === 'string') return note.trim() ? [note.trim()] : [];
        if (!note || typeof note !== 'object' || typeof note.text !== 'string' || !note.text.trim()) return [];
        const by = typeof note.by === 'string' ? note.by.trim() : '';
        return [by ? { text: note.text.trim(), by } : { text: note.text.trim() }];
      })
    : [];
  return {
    baseUrl,
    token,
    ...(folders.length > 0 ? { folders } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

export async function configureUnpacked({
  configPath = resolve(homedir(), '.config/marktab/local.json'),
  outputDir = resolve(projectRoot, '.output/chrome-mv3'),
} = {}) {
  const rawConfig = await readFile(configPath, 'utf8');
  let source;
  try {
    source = JSON.parse(rawConfig);
  } catch {
    throw new Error('Local config is not valid JSON.');
  }
  const config = normaliseLocalConfig(source);

  const bundledConfigPath = resolve(outputDir, 'marktab-local.json');
  await writeFile(bundledConfigPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(bundledConfigPath, 0o600);

  // Safe operational output: origin and paths only, never the API key.
  console.log(
    `Preconfigured Pins for ${permissionOrigin(config.baseUrl)}; Chrome still requires one click on Enable Pins to grant access to that host.`,
  );
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
