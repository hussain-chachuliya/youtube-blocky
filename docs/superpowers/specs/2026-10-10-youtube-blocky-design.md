# YouTube-Blocky — TizenTube Channel & Keyword Blocklist — Design

**Date:** 2026-10-10
**Status:** Draft — awaiting spec review before implementation plan
**Repo:** `youtube-blocky` (greenfield; patch for `reisxd/TizenTube` / `KrX3D/TizenTube`)
**Approach:** Option A — Direct TizenTube fork patch (recommended), extractable to companion module later

---

## 1. Overview

Enable TizenTube users on Samsung Tizen TVs to block:

* **Search terms / keywords** — user adds multiple terms; any video whose title contains any term (case-insensitive substring) is hidden globally (home, search results, recommendations, subscriptions, channel grids, continuations).
* **Channels** — user types a channel name, sees autocomplete suggestions (channel thumbnails + names), selects one; stored as `{id, name}` and hidden globally. Also allow one-click "Block Channel" from a playing video or shelf long-press.

No existing TizenTube feature covers this. Closest are `enableShorts` / `hideWatchedVideos` (shelf filtering) and BlockTube (browser extension) which is the reference for matching logic.

**Goals:** Pre-render filtering (item never appears), TV-friendly d-pad UI, reuse TizenTube's `JSON.parse` + `config.js` + `KabukiInnerTubeClient` patterns, zero new native dependencies.

**Non-goals (v1):** Regex keyword rules, description/category filtering, comment filtering, per-shelf toggles, import/export via QR, proxy-level filtering, DOM hiding fallback.

---

## 2. Architecture

### 2.1 Pattern

Follow `mods/features/adblock.js` exactly. All YouTube TV data flows through a single `JSON.parse` monkey-patch; filtering mutates the parsed JSON before YouTube renders.

```
userScript.js
  → imports blocklist.js
  → adblock.js JSON.parse patch
      → deArrowify / hqify
      → filterItems(blocklist)   ← new
      → hideVideo / addLongPress
```

Single wrapper avoids double-patch ordering bugs. A future companion module (`@scope/blocky`) can import `blocklist.js` standalone.

### 2.2 Files

| File | Change |
|------|--------|
| `mods/config.js` | Add `blockedKeywords`, `blockedChannels`, `enableKeywordBlocking`, `enableChannelBlocking` defaults |
| `mods/features/blocklist.js` | **New** — `extractTitle`, `extractChannel`, `isBlocked`, `filterItems`, channel search helper |
| `mods/features/adblock.js` | Import blocklist, call `filterItems` at 6 interception sites; extend `addLongPress` with "Block Channel" |
| `mods/userScript.js` | One-line import of `blocklist.js` |
| `mods/ui/settings.js` | New top-level "Blocklist" submenu; keyword/channel list management |
| `mods/resolveCommand.js` | Handle `BLOCK_CHANNEL`, `BLOCKLIST_ADD/REMOVE` custom actions |
| `mods/ui/ytUI.js` | No change (reuse `buttonItem`, `overlayPanelItemListRenderer`, `showModal`) |
| `mods/translations/resources/en.json` (+ other locales) | i18n keys for blocklist UI/toasts |
| `mods/utils/innerTubeCalls.js` | Optional helper `searchChannels(query)` (or inline in blocklist.js) |

No changes to `standalone/service/*` or proxy.

### 2.3 Interception Sites

All sites already patched by `adblock.js`:

1. `r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents` — home
2. `r.contents.sectionListRenderer.contents` — generic browse
3. `r.continuationContents.sectionListContinuation.contents` / `horizontalListContinuation.items` / `gridContinuation.items` — infinite scroll/continuations
4. `r.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections[].tabs[].tabRenderer.content...sectionListRenderer` — subscriptions/library tabs
5. `r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents` — watch-next / related
6. `r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.gridRenderer.items` — channel pages

Each calls `filterItems(items)` after `deArrowify`/`hqify`, before `hideVideo`/`addLongPress`.

---

## 3. Data Model & Config

Extend `defaultConfig` in `mods/config.js`:

```js
blockedKeywords: [],        // string[] — normalized lowercased, trimmed
blockedChannels: [],        // { id: string|null, name: string, addedAt: number }[]
enableKeywordBlocking: true,
enableChannelBlocking: true,
```

* Persistence: `window.localStorage['ytaf-configuration']` via `configRead`/`configWrite` + `configChangeEmitter` (existing mechanism). No new storage key.
* Write-time normalization: keywords → `kw.trim().toLowerCase()`; reject empty/duplicate (case-insensitive); channels dedup by `id` if present else `name.toLowerCase()`.
* Limits: 200 keywords, 200 channels (enforced on write; filter remains O(n) safe).
* Migration: `configRead` auto-populates defaults if missing; no data loss on upgrade.
* Events: `configWrite` fires `configChange`; open shelves refilter on next `JSON.parse` (no restart needed).

---

## 4. Filtering Engine

### 4.1 Extractors

Handle both renderers YouTube TV uses:

```js
function extractTitle(item): string|null {
  return item.tileRenderer?.metadata?.tileMetadataRenderer?.title?.simpleText
      ?? item.lockupViewModel?.metadata?.lockupMetadataViewModel?.title?.content
      ?? item.lockupViewModel?.contentImage?.thumbnailViewModel?.overlays // no
      ?? null;
}

function extractChannel(item): {id: string|null, name: string|null} {
  const name =
    item.tileRenderer?.metadata?.tileMetadataRenderer?.lines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text?.runs?.[0]?.text
    ?? item.tileRenderer?.metadata?.tileMetadataRenderer?.lines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text?.simpleText
    ?? item.lockupViewModel?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content
    ?? item.shortBylineText?.runs?.[0]?.text
    ?? item.longBylineText?.runs?.[0]?.text
    ?? null;

  const id =
    item.tileRenderer?.onSelectCommand?.watchEndpoint?.browseId
    ?? item.tileRenderer?.menu?.menuRenderer?.items?.find(i=>i.menuNavigationItemRenderer?.navigationEndpoint?.browseEndpoint?.browseId)?.menuNavigationItemRenderer.navigationEndpoint.browseEndpoint.browseId
    ?? item.lockupViewModel?.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.ownerChannelId
    ?? item.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId
    ?? null;

  return { id, name };
}
```

Probe order is defensive; if `id` absent, fall back to name-only matching.

### 4.2 Matching

```js
function isBlocked(item): boolean {
  if (!configRead('enableKeywordBlocking') && !configRead('enableChannelBlocking')) return false;
  const title = extractTitle(item);
  const titleLower = title?.toLowerCase() ?? "";

  if (configRead('enableKeywordBlocking') && titleLower) {
    const kws = configRead('blockedKeywords'); // already lowercased
    for (const kw of kws) if (titleLower.includes(kw)) return true;
  }

  if (configRead('enableChannelBlocking')) {
    const ch = extractChannel(item);
    const channels = configRead('blockedChannels');
    if (ch.id && channels.some(c => c.id === ch.id)) return true;
    if (ch.name && channels.some(c => c.name.toLowerCase() === ch.name.toLowerCase())) return true;
  }

  return false;
}

function filterItems(items: any[]): any[] {
  if (!items?.length) return items;
  const kws = configRead('blockedKeywords');
  const chs = configRead('blockedChannels');
  if (!kws.length && !chs.length) return items;
  if (!configRead('enableKeywordBlocking') && !configRead('enableChannelBlocking')) return items;
  // In-place splice like processShelves does, or return filtered copy like hideVideo.
  // Return filtered copy for simplicity (hidden items never render).
  return items.filter(item => {
    if (!item.tileRenderer && !item.lockupViewModel) return true; // keep non-video items
    return !isBlocked(item);
  });
}
```

* Early exit if both lists empty.
* Lowercase once per item.
* Non-video items (ads already stripped, shelves) pass through.
* Call sites: `shelfRenderer.content.horizontalListRenderer.items = filterItems(...)`, same for `gridRenderer.items` and continuation items. If a shelf becomes empty, leave empty (YouTube collapses it); like `enableShorts`, optionally `shelves.splice` if `items.length===0`.

### 4.3 Performance

Worst-case shelf 50 items × 200 keywords = 10k `String.includes` per page — negligible in `JSON.parse` hot path. No regex, no allocation beyond one `toLowerCase`.

---

## 5. Channel Autocomplete Provider

* Reuse `KabukiInnerTubeClient` (located via `Object.values(window._yttv).find(a=>a?.mappings).get('KabukiInnerTubeClient')` as in `innerTubeCalls.js`).
* Input debounced 300 ms, cached last 20 queries.

```js
async function searchChannels(query: string): Promise<{id,name,thumb}[]> {
  const KabukiInnerTubeClient = getKabukiClient();
  const resp = await KabukiInnerTubeClient.fetch({
    path: '/youtubei/v1/search',
    payload: { query, params: 'EgIQAg%3D%3D' } // channel-only filter
  }).toPromise(); // or subscribe wrapper
  // Parse: resp.contents.sectionListRenderer.contents[0].itemSectionRenderer.contents
  // Each entry: channelRenderer or compactChannelRenderer → { channelId, title.simpleText, thumbnail.thumbnails[0].url }
}
```

* Limit 8 suggestions, show thumbnail + name, d-pad vertical list + OK to select.
* On select: `configWrite('blockedChannels', [...prev, { id, name, addedAt: Date.now() }])` + toast.
* Fallback: if network fails or no results, allow "Add by name" (store `id:null`, match name-only).

---

## 6. Settings UI & Player Action

### 6.1 Blocklist Settings

New entry in `settings.js` `settings[]` array:

```js
{
  name: t('settings.options.blocklist.title'), icon: 'BLOCK', value: null,
  menuId: 'tt-blocklist', menuHeader: { title: ..., subtitle: ... },
  options: [
    { name: t('blocklist.enableKeywordBlocking'), value: 'enableKeywordBlocking' },
    { name: t('blocklist.enableChannelBlocking'), value: 'enableChannelBlocking' },
    { name: t('blocklist.blockedKeywords'), value: null, menuId:'tt-blocked-keywords',
      options: dynamicList('blockedKeywords', { addAction:'BLOCKLIST_ADD_KEYWORD', removeAction:'BLOCKLIST_REMOVE_KEYWORD' }) },
    { name: t('blocklist.blockedChannels'), value: null, menuId:'tt-blocked-channels',
      options: dynamicList('blockedChannels', { addAction:'BLOCKLIST_ADD_CHANNEL', removeAction:'BLOCKLIST_REMOVE_CHANNEL' }) },
  ]
}
```

* `Blocked Keywords` submenu: renders current list via `configRead('blockedKeywords').map(kw => buttonItem(... remove ...))` + top `Add keyword` button → overlay prompt → `configWrite`.
* `Blocked Channels` submenu: list + `Add channel` → overlay with text input + live suggestion list (from §5) → select → `configWrite`.
* All items use `setClientSettingEndpoint` (toggles) or `customAction` → `resolveCommand.js` → `configWrite` + toast + `configChangeEmitter`.
* Input overlay: `overlayMessageRenderer` + native `<input>` element (Tizen IME supports remote/phone keyboard). v1 uses `window.prompt` fallback if overlay input unavailable. No new deps.

### 6.2 Shelf Long-Press & Watch Page "Block Channel"

* **Shelf long-press:** Extend `addLongPress(items)` in `adblock.js`:
  ```js
  menuItems.push(MenuServiceItemRenderer(t('blocklist.blockChannel'), {
    clickTrackingParams: null,
    customAction: { action:'BLOCK_CHANNEL', parameters: { id, name, source:'shelf' } }
  }));
  ```
  Extract `id`/`name` from `copiedItem` (same helpers as §4.1). Insert after "Add to Queue".

* **Watch page:** In `JSON.parse` patch where `channelHeaderRenderer.buttons` are augmented (existing "Add to Sidebar" injection), add:
  ```js
  buttons.push({ buttonRenderer: ButtonRenderer(false, t('blocklist.blockChannel'), 'BLOCK', { customAction:{action:'BLOCK_CHANNEL', parameters:{id:browseId, name:title}}})})
  ```

* **Handler in `resolveCommand.js`:**
  ```js
  case 'BLOCK_CHANNEL': {
    const { id, name } = params;
    const prev = configRead('blockedChannels');
    if (prev.some(c => c.id===id || c.name.toLowerCase()===name.toLowerCase())) { toast('Already blocked'); break; }
    configWrite('blockedChannels', [...prev, { id, name, addedAt: Date.now() }]);
    toast(t('blocklist.toasts.channelBlocked', { name }));
    break;
  }
  case 'BLOCKLIST_ADD_KEYWORD': { /* prompt, normalize, dedup, write */ }
  case 'BLOCKLIST_REMOVE_KEYWORD': { /* splice, write */ }
  // similar for channels
  ```

* Toast via `overlayMessageRenderer` or `timelyActionRenderer` pattern already used for SponsorBlock.

### 6.3 Navigation

All new menus reuse `showModal` + `overlayPanelItemListRenderer` with d-pad focus, `selectedIndex` tracking, and `update` flag — consistent with existing TizenTube settings navigation.

---

## 7. Edge Cases & Error Handling

* Empty blocklists → `filterItems` early return, zero cost.
* Duplicates → rejected on write (keyword lowercased, channel id/name equality).
* Missing title/channel → fail open (not blocked); never hide unparseable items.
* Empty shelves after filtering → leave empty (YouTube collapses) or `shelves.splice` if length 0 (mirror `enableShorts`).
* Continuations → same filter applied (`horizontalListContinuation` / `gridContinuation`).
* Search for blocked term → YouTube returns items, we strip them; if all stripped, user sees no results (expected).
* Storage: ~20 KB for 400 entries; well under 5 MB `localStorage` limit.
* Corrupt config → `config.js` try/catch falls back to defaults.
* Network failure for channel search → fallback to name-only manual add; toast error but don't block UI.

---

## 8. Build, Distribution & Testing

### 8.1 Build

No new npm deps. `mods/rollup.config.js` already bundles `mods/userScript.js` → `dist/userScript.js`. New `blocklist.js` auto-included. `npm run build` unchanged.

### 8.2 Distribution

* Fork `reisxd/TizenTube` → branch `feat/blocklist` → PR.
* Released via TizenBrew Module Manager as NPM `@krx3d/tizentube2` (today's channel) or new `@scope/youtube-blocky` wrapper that imports TizenTube + blocklist (extractable from `blocklist.js`).
* Standalone `wgt` sideload via Tizen Studio for testing.

### 8.3 Testing

* **Unit (vitest/jest):** `isBlocked` / `extractTitle` / `extractChannel` with fixtures for `tileRenderer` and `lockupViewModel` variants, case-insensitive keyword, id vs name, empty, mixed, 200-entry perf.
* **Manual (Tizen Studio emulator + real TV Tizen 6.5/7.0):** Verify filtering on home/search/subscriptions/watch-next/channel grids/continuations; long-press menu item appears; watch-page button blocks; settings add/remove persist across restart; toggles disable filtering; no regression to adblock/SponsorBlock.
* **No telemetry.** Network only to YouTube `youtubei/v1/search` for channel suggestions (same domain as normal browsing).

---

## 9. Open Questions for Implementation

* Exact `browseId` extraction path for channel id from shelf items — verify on live TV JSON (probe 3 paths above; log missing cases to console in debug build).
* Whether to also filter `adSlotRenderer` shelves that slip past adblock — current `processShelves` already strips them first.

---

## 10. Rollout

1. Implement `blocklist.js` + config + `adblock.js` hooks + tests.
2. Implement settings UI + `resolveCommand` handlers.
3. Implement channel autocomplete provider.
4. End-to-end manual test on emulator + TV; capture before/after screenshots.
5. Submit PR / publish TizenBrew module.

---

*Spec self-review: no TBD/TODO, architecture matches feature descriptions, scope is single spec (blocklist), requirements are unambiguous (title substring + id/name channel, prompt fallback for input).*
