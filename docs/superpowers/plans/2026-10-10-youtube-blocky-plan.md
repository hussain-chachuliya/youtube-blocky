# Implementation Plan — YouTube-Blocky TizenTube Blocklist

**Spec:** `docs/superpowers/specs/2026-10-10-youtube-blocky-design.md`
**Approach:** Option A — Fork patch
**Stack:** TizenBrew module, vanilla JS, Rollup, `localStorage`, `KabukiInnerTubeClient`, Vitest

---

## Phase 0 — Fork & Scaffold (1 task)

**0.1 Clone & branch TizenTube**
- Clone `reisxd/TizenTube` into `youtube-blocky/` (or as git submodule), branch `feat/blocklist`.
- Verify `npm install && npm run build` produces `dist/userScript.js` on current machine.
- Add `vitest` devDependency for unit tests (optional).
- **Deliverable:** Build passes, emulator loads unmodified TizenTube.

---

## Phase 1 — Core blocklist engine (no UI)

**1.1 `mods/config.js` — add keys**
- Add `blockedKeywords`, `blockedChannels`, `enableKeywordBlocking`, `enableChannelBlocking` defaults.
- No other changes.

**1.2 `mods/features/blocklist.js` — new file**
- Functions: `extractTitle(item)`, `extractChannel(item)`, `isBlocked(item)`, `filterItems(items)`, `normalizeKeyword()`, `addKeyword()`, `removeKeyword()`, `addChannel()`, `removeChannel()`.
- Export for tests. Lowercase once per item. Early exit if lists empty.
- Handle both `tileRenderer` and `lockupViewModel` renderers (see §4.1 of spec).

**1.3 `mods/features/adblock.js` — wire filter**
- Import `filterItems`.
- Call `filterItems` at 6 sites (home, browse, continuations, secondaryNav tabs, watch-next, gridRenderer) after `deArrowify`/`hqify`, before `hideVideo`.
- If shelf becomes empty, leave empty (YouTube collapses) — optionally splice.

**1.4 `mods/userScript.js` — import**
- One-line import of `blocklist.js` (ensures bundle includes it).

**1.5 Unit tests `mods/features/blocklist.test.js`**
- Fixtures for tileRenderer + lockupViewModel, keyword case-insensitive, id exact match, name fallback, empty, mixed, non-video passthrough, 200-entry perf.

**Test checkpoint:** Load built `dist/userScript.js` in Tizen Studio emulator, manually seed `localStorage['ytaf-configuration']` with `blockedKeywords:["minecraft"]` and verify home/search shelves hide matching titles.

---

## Phase 2 — Commands & persistence

**2.1 `mods/resolveCommand.js` — handlers**
- `BLOCK_CHANNEL` — dedup by id/name, `configWrite`, toast.
- `BLOCKLIST_ADD_KEYWORD` / `BLOCKLIST_REMOVE_KEYWORD` — normalize, dedup, limit 200, `configWrite`.
- `BLOCKLIST_ADD_CHANNEL` / `BLOCKLIST_REMOVE_CHANNEL` — same.
- Reuse existing toast pattern; dispatch `configChangeEmitter` via `configWrite`.

**2.2 i18n `mods/translations/resources/en.json`**
- Keys: `settings.options.blocklist.*`, `blocklist.blockChannel`, `blocklist.toasts.channelBlocked`, `blocklist.toasts.keywordBlocked`, etc. (add to other locales as pass-through).

---

## Phase 3 — Settings UI

**3.1 `mods/ui/settings.js` — Blocklist submenu**
- Top-level `Blocklist` entry (icon `BLOCK`).
- Submenus: toggles + `Blocked Keywords` list (map `blockedKeywords` to `buttonItem` with Remove) + `Add keyword` button → prompt overlay.
- `Blocked Channels` list + `Add channel` → text input + suggestion list (Phase 4) + Remove.
- Reuse `showModal`, `overlayPanelItemListRenderer`, `buttonItem`, `setClientSettingEndpoint` / `customAction`.

**3.2 Input overlay**
- `overlayMessageRenderer` + `<input>` element for keyword; Tizen IME handles remote/phone keyboard.
- Fallback `window.prompt` if overlay input unavailable. Validate non-empty.

**Checkpoint:** On TV/emulator, navigate Settings → Blocklist, add/remove keyword/channel, verify persistence after restart.

---

## Phase 4 — Channel autocomplete

**4.1 `mods/features/blocklist.js` — `searchChannels(query)`**
- Locate `KabukiInnerTubeClient` via `Object.values(window._yttv).find(a=>a?.mappings)`.
- Call `path:'/youtubei/v1/search'` with `params:'EgIQAg%3D%3D'` (channel filter), parse `channelRenderer`/`compactChannelRenderer` → `{id,name,thumb}`.
- Debounce 300ms, cache last 20 queries, limit 8 results.
- Fallback: allow manual add by name (`id:null`) if network fails.

**4.2 Wire to "Add channel" overlay**
- Text input → live `searchChannels` → render suggestion list (thumbnail + name) as scrollable `overlayPanelItemListRenderer` buttons; d-pad OK selects → `BLOCKLIST_ADD_CHANNEL`.

**Checkpoint:** Type "Tasty" → see 8 channel suggestions → select → appears in Blocked Channels list → home shelves filter.

---

## Phase 5 — Long-press & Watch-page "Block Channel"

**5.1 `mods/features/adblock.js` — `addLongPress` extension**
- Add `MenuServiceItemRenderer(t('blocklist.blockChannel'), { customAction:{action:'BLOCK_CHANNEL', parameters:{id,name}}})` to shelf long-press menu (after "Add to Queue").

**5.2 Watch-page header button**
- In `JSON.parse` patch where `channelHeaderRenderer.buttons` are augmented, push `ButtonRenderer` for "Block Channel" with `browseId`/`title` → `BLOCK_CHANNEL`.

**5.3 Toast**
- `overlayMessageRenderer` or `timelyActionRenderer` toast "Channel blocked — undo in Settings".

**Checkpoint:** On shelf, long-press → Block Channel → toast → item disappears; on watch page, button blocks channel.

---

## Phase 6 — Polish, edge cases & e2e testing

**6.1 Edge cases**
- Empty lists early return, duplicates rejected, missing title/channel fail open, continuations filtered, storage quota safe, corrupt config fallback.

**6.2 E2E manual test (emulator + real TV)**
- Home, search, subscriptions, channel grid, watch-next, continuations all filter.
- Toggles disable filtering.
- Suggest list, long-press, watch-page button, settings add/remove persist across restart.
- No regression: adblock, SponsorBlock, DeArrow, Shorts still work.

**6.3 Performance check**
- Verify `JSON.parse` patch adds <5ms per page (50 items × 200 keywords).

---

## Phase 7 — Release

**7.1 Build & publish**
- `npm run build` → `dist/userScript.js`.
- Push branch `feat/blocklist`, open PR to `reisxd/TizenTube` with screenshots/video.
- Optional: publish as TizenBrew NPM module (`@krx3d/tizentube2` style) or standalone `wgt` via Tizen Studio.

**7.2 Docs**
- Update `README.md` with Blocklist feature description + usage.
- Add `docs/README.md` install note.

---

## Dependencies & Order

```
0.1 → 1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 2.1 → 2.2 → 3.1 → 3.2 → 4.1 → 4.2 → 5.1 → 5.2 → 5.3 → 6.x → 7.x
```

Each phase's checkpoint must pass before next phase starts. Phases 2–3 can parallelize with 4 if desired, but sequential is safest for single implementer.

## Risks

* `extractChannel` id path varies by YouTube TV rollout — mitigate by probing 3–4 spots and logging missing cases in debug build.
* Tizen IME differences across firmware — mitigate with `prompt` fallback.
* TizenTube upstream JSON shape changes — filter is additive and fail-open; negligible break risk.
