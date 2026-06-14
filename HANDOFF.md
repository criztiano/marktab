# Handoff — marktab

Status as of 2026-06-14. Built in a Cowork session; continuing in Claude Code.

## What this is

Chrome extension replacing the new tab page with a minimal, searchable bookmark list, read live from `chrome.bookmarks`. Doubles as a personal WXT starter template (see README "Using this as a template").

## Current state — working & verified

- Loads and works in Chrome (tested by Criss, daily-driving it).
- Build is clean: `npm run build` and `npm run compile` both pass.
- Features shipped, in order of iteration:
  1. Flat searchable list grouped by folder, favicons from Chrome's local cache, live updates via bookmark events, Enter opens first match, dark mode.
  2. Horizontal columns (one per folder), sticky centered search bar.
  3. Masonry layout via CSS multi-column (`columns: 280px`, `break-inside: avoid`) — replaced the grid because short folders left dead space.
  4. Loose Bookmarks-Bar bookmarks hidden (`HIDDEN_ROOTS` set, id '1'), section titles show folder name only (no breadcrumb), 56px vertical gap between stacked sections.
  5. UI/UX pass (2026-06-12): arrow-key navigation through results, Esc to clear, type-anywhere refocuses search; a11y (search landmark/label, aria-live match count, focus-visible rings, `--muted` contrast ≥4.5:1 in both themes); match highlighting via `<mark>`; tooltips show title + URL. Project renamed to **marktab**.
  6. "Try next" feed (2026-06-14): horizontal card row above the columns (hidden while searching), fed by `GET /api/marktab/queue`; click opens + `POST …/opened` (keepalive), hover-dismiss + `POST …/dismiss`; collapses when empty/unreachable. First network layer — adds `storage`. Adapter unit-tested with Vitest (`feed.test.ts`). Verified live in Chrome for Testing with mocked endpoints (light + dark, render/dismiss/open/empty).
  7. Settings modal (2026-06-14): gear button (top-right) → modal to set the feed base URL + token, Save persists and tests the connection inline. https required when a token is set. `Settings.tsx` + `saveConfig`. Verified live (ok/error/guards, Escape/overlay/focus, light + dark).
  8. Try-next caching + reveal (2026-06-14): stale-while-revalidate cache in `browser.storage.local` (cached cards paint instantly, no skeleton; background refresh re-caches; `dismissedRef` stops an in-flight refresh from resurrecting a dismissed item). Empty→cards reveal animates the section height (grid-rows) then blur-fades the cards in, staggered; honors `prefers-reduced-motion`. Verified live (cold/warm/offline/dismiss, cache sync, light + dark).
  9. Public packaging (2026-06-14): genericized the feed for open-sourcing — `eden.ts`→`feed.ts` (Eden→feed throughout), **empty default base URL** (dormant until configured, no host in code), `host_permissions` replaced by `optional_host_permissions` granted per-host at runtime on Settings save (`requestHostAccess`). `loadConfig` migrates legacy `eden*` storage keys. README documents the bring-your-own-backend API contract. Verified: manifest has no host_permissions, no tailnet host in source/build.

## Deliberate decisions (don't relitigate casually)

- **Core bookmark browsing is request-free.** Favicons via Chrome's `_favicon/` endpoint, not Google's favicon service. The one exception is the optional **"Try next" feed** — dormant until the user configures a host (no host shipped; access granted per-host at runtime). Everything else stays local.
- **No Tailwind/UI lib** — plain CSS custom properties. The extension is ~150 lines of React; keep it that way.
- **Masonry trade-off accepted**: column order balances by height, not strict bookmark order.
- **Full tree reload on any bookmark event** — trivial at bookmark scale.

## Backlog

The UI/UX review session shipped (item 5 above). Edge states verified live: very long titles ellipsize with full tooltip, 100+-item folders render fine, missing favicons fall back to Chrome's default globe (the `_favicon/` endpoint never 404s). Remaining candidate:

- Maybe: configurable hidden roots (Other/Mobile bookmarks) via an options page — only if it stays minimal.

## Repo facts

- MIT licensed, author Cristiano Troffei.
- `CLAUDE.md` has stack conventions and commands.
- `.output/`, `.wxt/`, `node_modules/` are gitignored; the committed tree is source-only.
- README includes user-facing install instructions (Load unpacked from `.output/chrome-mv3/`).
