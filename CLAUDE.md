# marktab

Chrome extension that replaces the new tab page with a minimal, searchable, masonry-layout list of the user's bookmarks, read live from `chrome.bookmarks`.

## Stack & conventions

- **WXT** (v0.20.x) + **React 18** + **TypeScript**, Manifest V3.
- WXT generates `manifest.json` from `wxt.config.ts` + entrypoint folder names. Never write a manifest by hand.
- `browser.*` is auto-imported by WXT (cross-browser, promise-based). Don't import `chrome` directly.
- The whole UI lives in `entrypoints/newtab/` (App.tsx + style.css). Keep it single-entrypoint unless a feature truly needs a background worker.
- Plain CSS with custom properties (no Tailwind). Dark mode via `prefers-color-scheme`.
- Favicons come from Chrome's local cache: `chrome-extension://{id}/_favicon/?pageUrl=...` (requires `favicon` permission). No external favicon services — core bookmark browsing stays request-free.
- **Network:** the only network layer is the optional "Pins" feed (`entrypoints/newtab/feed.ts` + `Pins.tsx`). No host is hardcoded and none is requested at install. Public builds stay dormant until the user sets a base URL in Settings; local builds may bundle a private config but still require an explicit **Enable Pins** click. Both paths grant one host through `optional_host_permissions` (`optional_host_permissions: ['https://*/*','http://localhost/*']` in `wxt.config.ts`). Base URL + token live in `browser.storage.local` (`storage` permission); `loadConfig` migrates the legacy `eden*` keys. Keep all other surfaces request-free. The "Open tabs" panel uses `scripting` plus a runtime grant of `https://*/*` + `http://*/*` (also in `optional_host_permissions`) — no network, but that grant also satisfies Pins' per-host check.

## Commands

- `npm run dev` — Chrome with HMR
- `npm run build` — generic production build to `.output/chrome-mv3/`
- `npm run build:local` — private unpacked build; reads `~/.config/marktab/local.json` and writes only the generated bundled config
- `npm run compile` — typecheck only (tsc --noEmit)
- `npm run zip` — store-ready zip

## Delivery rules

- Keep `DEFAULT_CONFIG` blank and public/WXT source generic. Never commit a host, token, generated `marktab-local.json`, or required private host permission.
- Local delivery uses `scripts/configure-unpacked.mjs` only after WXT builds. It writes `.output/chrome-mv3/marktab-local.json` mode 0600 but must leave the generated manifest generic (no required `host_permissions`) and never log the key. Chrome grants only the configured host after the user clicks **Enable Pins**.
- Keep `package.json` and `BUNDLE_VERSION` aligned. The new-tab entrypoint compares the bundle version to runtime manifest metadata and requests at most one runtime reload when cached assets are newer.

## Architecture notes

- `flatten()` in App.tsx walks the bookmark tree and emits one section per folder that directly contains bookmarks. Section title = folder name only (not breadcrumb path — deliberate UX decision).
- `HIDDEN_ROOTS` (Chrome root folder ids: '1' = Bookmarks Bar) suppresses sections for loose bookmarks in those roots; subfolders still render.
- Layout is CSS multi-column masonry (`columns: 280px`), sections use `break-inside: avoid`. Trade-off accepted: visual order is balanced by height, not strict bookmark order.
- Bookmark events (onCreated/onRemoved/onChanged/onMoved) trigger a full reload of the tree — fine at bookmark scale, don't prematurely optimize.
- Search filters by title/URL; Enter opens the first visible match in the current tab.
- Keyboard: arrows move real DOM focus between search and result links (no virtual cursor), Esc clears, typing anywhere refocuses search. Match highlighting wraps the first title hit in `<mark>`.
- `Pins.tsx` renders a horizontal "Pins" row above the columns, shown only when not searching. An unconfigured source stays collapsed; a configured source without `hasHostAccess` shows a compact **Enable Pins** state. Its click handler calls `requestHostAccess` before any other async work so Chrome sees the user gesture; a grant loads cache, creates the client, and fetches live items in place, while denial/cancellation leaves onboarding visible without an error. The feed is stale-while-revalidate: cached Garden pins (`loadCachedItems`) paint instantly, then `fetchQueue` refreshes and re-caches (`saveCachedItems`). Cards reserve 16:9 media geometry, render only direct safe public image/video plus title, and retain a Chrome local-favicon art fallback for absent/unsafe/failed media. Video posters may render immediately, but video sources remain unattached until near the viewport; playback is muted and in-view only, pauses offscreen, and stays disabled with reduced motion. Ordinary card navigation has no network mutation; only the explicit × unpin calls the compatibility dismiss endpoint. A V2 cache excludes historical queue cards, and config migration/save clears both cache generations.
- `Tabs.tsx` + `tab-usage.ts` (lowercase `tabs.ts` would clash with `Tabs.tsx` on macOS) render "Open tabs by memory": top `TAB_LIMIT` (12) http(s) tabs by `performance.memory.usedJSHeapSize`, read per tab via `scripting.executeScript` with a 1.5 s timeout; discarded, non-web and unanswered tabs are skipped. Stable Chrome has no per-tab process memory (`chrome.processes` is dev-channel only), so figures are JS-heap estimates, shared by same-site tabs in one process, and cached by Chrome for up to 20 min. Before the grant it shows a **Show tabs** prompt (request first in the click). Once granted, `.layout` becomes a 1fr/2fr grid (bookmarks | tabs) via `:has(.tabs[data-open])`; while searching the panel is hidden but stays mounted. Re-measures on tab create/remove/replace/load-complete and on visibility, only while visible. Row click focuses the tab; × closes it optimistically.
- Optional `folders` in `~/.config/marktab/local.json` → bundled `marktab-local.json` (`local-config.ts`) limits bookmark sections to those folder names (case-insensitive; falls back to all when none match). Public builds show all folders.
- `Settings.tsx` is the gear-button modal ("Pins source") for the feed base URL + token. Save calls `requestHostAccess` first (within the click gesture — Chrome requires a gesture for `permissions.request`), then `saveConfig`, then tests via `fetchQueue`. App owns a `reloadKey` that keys `<Pins>` so saving re-fetches. Escape/Tab handled by a capture-phase document listener so Escape doesn't also trigger App's search-clear.

## Known state / next steps

Shipped: bookmark search/masonry, keyboard nav, a11y pass, dark mode, the optional "Open tabs by memory" panel, and the optional Pins feed (configurable backend, per-host runtime permission). Public on GitHub.
