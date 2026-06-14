import { defineConfig } from 'wxt';

// WXT generates manifest.json from this config + your entrypoints/ folder.
// Docs: https://wxt.dev/guide/essentials/config/manifest
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'marktab',
    description: 'Your bookmarks as a fast, minimal new tab page.',
    permissions: [
      'bookmarks', // read the bookmark tree
      'favicon', // use Chrome's local favicon cache (no external requests)
      'storage', // persist the Try-next feed base URL + token (see entrypoints/newtab/feed.ts)
    ],
    // The "Try next" feed talks to whatever host the user configures. Access is
    // optional and granted per-host at runtime (Settings → Save), so a fresh
    // install requests nothing and no host is baked into the extension. https for
    // real hosts; plain http only for localhost (dev).
    optional_host_permissions: ['https://*/*', 'http://localhost/*'],
  },
});
