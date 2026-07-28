# marktab

Replaces Chrome's new tab page with a minimal, searchable list of your bookmarks. Reads them live from Chrome's own bookmark store (`chrome.bookmarks`) — no syncing, no backend, updates automatically when you add/remove bookmarks.

**This repo doubles as a starter template for new Chrome extensions.** See "Using this as a template" below.

## Stack

- [WXT](https://wxt.dev) — extension framework (manifest generation, HMR dev server, cross-browser builds, store publishing)
- React 18 + TypeScript
- Manifest V3

## Quick start

```bash
npm install
npm run dev        # opens Chrome with the extension loaded, hot reload
```

### Load a production build manually

```bash
npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `.output/chrome-mv3/`.

For a private unpacked build with Pins preconfigured, create `~/.config/marktab/local.json`:

```json
{ "baseUrl": "https://pins.example", "apiKey": "your-private-key" }
```

Then run `npm run build:local`. It builds the same generic extension and writes only a generated `marktab-local.json` into `.output/chrome-mv3/`; it does **not** add required `host_permissions`. Both generic and local manifests retain only the optional per-host permission patterns. On the first new or upgraded local launch, click **Enable Pins** in the Pins row and approve Chrome's one-time grant for the configured host; Pins loads immediately without a page reload. The generated config contains the key: keep the output private and never commit or publish it.

### Other commands

```bash
npm run build:local     # private unpacked build from ~/.config/marktab/local.json
npm run build:firefox   # Firefox build
npm run zip             # store-ready zip
npm run compile         # typecheck only
```

## How it works

- `entrypoints/newtab/` — WXT sees the folder name and automatically adds `chrome_url_overrides.newtab` to the manifest. Your page becomes the new tab.
- `browser.bookmarks.getTree()` — full bookmark tree, flattened into one section per folder.
- Bookmark events (`onCreated`, `onRemoved`, `onChanged`, `onMoved`) re-render the list live.
- Favicons come from Chrome's local cache via the `_favicon/` endpoint (`favicon` permission) — no external requests for core bookmark browsing.
- Search box filters by title/URL; Enter opens the first match.
- **Pins** (optional) — see [below](#pins-optional-feed). Off until you point it at a server; otherwise the new tab is just your bookmarks.

### Pins (optional feed)

"Pins" is an **optional** horizontal row backed by persistent pins from your Garden. It ships **dormant** — the extension requests no network access at install and the row stays hidden until you configure a server. The feed client talks only to that configured host.

**Configure it** with the **gear button** (top-right): enter your server's base URL (+ an optional API token) and hit **Save & test**. Chrome asks once for that host; then Marktab saves the values and verifies the connection inline. An `https` URL is required when you set a token.

A local build is already configured, so its first new tab instead shows a compact **Enable Pins** prompt. Clicking it asks Chrome for only that configured host, then paints the V2 cache immediately and refreshes live pins in place. Cancelling leaves the prompt ready to try again and does not affect bookmark browsing.

**Backend contract** — expose these endpoints at the configured base URL:

| Method & path | Purpose |
|---|---|
| `GET /api/marktab/queue?limit=12` | Return persistent Garden pins (limit is bounded to 1–50) |
| `POST /api/marktab/queue/:id/dismiss` | Explicitly unpin via the compatibility route |

Ordinary card opening is navigation-only and sends no mutation. The `GET` returns `{ "items": [...] }`, each item:

```jsonc
{
  "id": "string",               // required
  "title": "string",            // required
  "url": "https://…",           // required (http/https only)
  "media": {                     // optional canonical media
    "kind": "image | video",
    "url": "https://…",         // direct public media only
    "poster_url": "https://…"   // optional video poster
  },
  "image_url": "https://…",     // optional image compatibility alias
  "source": "garden",
  "pinned_at": "ISO string"
}
```

Cards are media-first and show only the pin title. Direct public images and videos load natively with reserved 16:9 geometry; missing, unsafe, protected, or failed media falls back to an art treatment using Chrome's local favicon cache. Authenticated Garden media proxy URLs such as `/api/garden/media` and `/remote-media` are deliberately not embedded because media elements cannot send the feed token. A video's poster may paint immediately, but its source is omitted until the card nears the viewport; it then upgrades to metadata preload, plays muted only while in view, pauses offscreen, and never autoplays under reduced-motion preferences.

If a token is configured it is sent as both `Authorization: Bearer …` and `x-api-key: …` for backend compatibility. Authenticated Marktab API endpoints must be direct: HTTP redirects are rejected so credentials remain on the configured origin. Items with a non-`http(s)` navigation URL are dropped for safety. Defaults and the client live in `entrypoints/newtab/feed.ts`.

## Using this as a template

1. Copy the repo, `rm -rf entrypoints/newtab` (or keep it as reference).
2. Add entrypoints by convention — WXT generates the manifest from folder names inside `entrypoints/`:
   - `popup/index.html` → toolbar popup
   - `background.ts` → MV3 service worker
   - `content.ts` → content script (define `matches` inside the file)
   - `options/index.html`, `sidepanel/index.html`, `newtab/index.html`, etc.
3. Permissions and other manifest fields go in `wxt.config.ts`.
4. `browser.*` is auto-imported and cross-browser (Chrome + Firefox).

Full entrypoint list: https://wxt.dev/guide/essentials/entrypoints

## Project structure

```
entrypoints/newtab/   # the new tab page (HTML + React app + CSS)
public/icon/          # extension icons
wxt.config.ts         # manifest config
.output/              # builds land here (gitignored)
```

## Privacy

Core bookmark browsing stays fully local: bookmarks are read via `chrome.bookmarks` and favicons come from Chrome's own cache — no network requests, and the extension requests **no host access at install**. Optional **Pins** traffic begins only after you configure and grant one feed host. Cards may then load the direct public image/video URLs returned by that feed; protected Garden media-proxy URLs are suppressed. Leave Pins unconfigured and Marktab never touches the network.

## License

[MIT](LICENSE)
