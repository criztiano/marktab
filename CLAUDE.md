# marktab

Chrome extension that replaces the new tab page with a minimal, searchable, masonry-layout list of the user's bookmarks, read live from `chrome.bookmarks`.

## Stack & conventions

- **WXT** (v0.20.x) + **React 18** + **TypeScript**, Manifest V3.
- WXT generates `manifest.json` from `wxt.config.ts` + entrypoint folder names. Never write a manifest by hand.
- `browser.*` is auto-imported by WXT (cross-browser, promise-based). Don't import `chrome` directly.
- The whole UI lives in `entrypoints/newtab/` (App.tsx + style.css). Keep it single-entrypoint unless a feature truly needs a background worker.
- Plain CSS with custom properties (no Tailwind). Dark mode via `prefers-color-scheme`.
- Favicons come from Chrome's local cache: `chrome-extension://{id}/_favicon/?pageUrl=...` (requires `favicon` permission). No external favicon services — core bookmark browsing stays request-free.
- **Network:** the only network layer is the optional "Pins" feed (`entrypoints/newtab/feed.ts` + `Pins.tsx`). No host is hardcoded and none is requested at install — the feed is dormant until the user sets a base URL in Settings; saving triggers a per-host `optional_host_permissions` grant (`optional_host_permissions: ['https://*/*','http://*/*']` in `wxt.config.ts`). Base URL + token live in `browser.storage.local` (`storage` permission); `loadConfig` migrates the legacy `eden*` keys. Keep all other surfaces request-free.

## Commands

- `npm run dev` — Chrome with HMR
- `npm run build` — production build to `.output/chrome-mv3/`
- `npm run compile` — typecheck only (tsc --noEmit)
- `npm run zip` — store-ready zip

## Architecture notes

- `flatten()` in App.tsx walks the bookmark tree and emits one section per folder that directly contains bookmarks. Section title = folder name only (not breadcrumb path — deliberate UX decision).
- `HIDDEN_ROOTS` (Chrome root folder ids: '1' = Bookmarks Bar) suppresses sections for loose bookmarks in those roots; subfolders still render.
- Layout is CSS multi-column masonry (`columns: 280px`), sections use `break-inside: avoid`. Trade-off accepted: visual order is balanced by height, not strict bookmark order.
- Bookmark events (onCreated/onRemoved/onChanged/onMoved) trigger a full reload of the tree — fine at bookmark scale, don't prematurely optimize.
- Search filters by title/URL; Enter opens the first visible match in the current tab.
- Keyboard: arrows move real DOM focus between search and result links (no virtual cursor), Esc clears, typing anywhere refocuses search. Match highlighting wraps the first title hit in `<mark>`.
- `Pins.tsx` renders a horizontal "Pins" row above the columns, shown only when not searching, and stays dormant unless a base URL is set **and** host access is granted (`hasHostAccess`). It's stale-while-revalidate: cached items (`loadCachedItems`) paint instantly with no skeleton, then a background `fetchQueue` refreshes and re-caches (`saveCachedItems`). The section stays mounted at zero height when empty so it can animate open (grid-rows height transition + staggered card blur-fade); a `dismissedRef` keeps an in-flight refresh from resurrecting a just-dismissed item. `feed.ts` holds the mockable client: pure `buildQueueUrl`/`buildHeaders`/`safeHttpUrl`/`originPattern` helpers + `createFeedClient(config, fetchImpl)` (inject both to test), plus `loadConfig`/`saveConfig`, `loadCachedItems`/`saveCachedItems`, and `hasHostAccess`/`requestHostAccess` (the only `browser.*` touches). `opened`/`dismiss` POSTs use `keepalive` so they survive the click-through navigation.
- `Settings.tsx` is the gear-button modal ("Pins source") for the feed base URL + token. Save calls `requestHostAccess` first (within the click gesture — Chrome requires a gesture for `permissions.request`), then `saveConfig`, then tests via `fetchQueue`. App owns a `reloadKey` that keys `<Pins>` so saving re-fetches. Escape/Tab handled by a capture-phase document listener so Escape doesn't also trigger App's search-clear.

## Known state / next steps

Shipped: bookmark search/masonry, keyboard nav, a11y pass, dark mode, and the optional Pins feed (configurable backend, per-host runtime permission). Public on GitHub.
