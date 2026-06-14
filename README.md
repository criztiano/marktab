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

### Other commands

```bash
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

"Pins" is an **optional** top row of cards you want to read/try later, served by *your own* backend. It ships **dormant** — the extension requests no network access at install and the row doesn't appear until you configure a server. It's the only part of marktab that ever touches the network, and only the host you set.

**Configure it** with the **gear button** (top-right): enter your server's base URL (+ an optional API token) and hit **Save & test**. The browser asks once to allow access to that host; then marktab saves the values and verifies the connection inline. An `https` URL is required when you set a token.

**Bring your own backend** — implement these three endpoints and point marktab at them:

| Method & path | Purpose |
|---|---|
| `GET /api/marktab/queue?status=queued&limit=12` | Return the cards to show |
| `POST /api/marktab/queue/:id/opened` | Called after a card is opened |
| `POST /api/marktab/queue/:id/dismiss` | Called when a card is dismissed |

The `GET` returns `{ "items": [...] }`, each item:

```jsonc
{
  "id": "string",            // required
  "title": "string",         // required
  "url": "https://…",        // required (http/https only)
  "description": "string",   // optional
  "image_url": "https://…",  // optional preview image
  "author": "string",        // optional
  "source": "string",
  "queued_at": "ISO string",
  "status": "queued"
}
```

If a token is configured it's sent as `Authorization: Bearer <token>`. Items with a non-`http(s)` `url` are dropped for safety. Defaults and the client live in `entrypoints/newtab/feed.ts`.

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

Core bookmark browsing stays fully local: bookmarks are read via `chrome.bookmarks` and favicons come from Chrome's own cache — no network requests, and the extension requests **no host access at install**. The only network traffic is the optional **Pins** feed: once you configure a server and grant access to it, marktab fetches the queue from that host (and loads each card's preview image from its own origin). Leave it unconfigured and marktab never touches the network.

## License

[MIT](LICENSE)
