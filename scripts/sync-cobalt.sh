#!/usr/bin/env bash
set -euo pipefail

# sync-cobalt.sh — keep youtube-blocky & TizenTubeCobalt up-to-date and build APK/WGT
# Usage:
#   ./scripts/sync-cobalt.sh           # sync & build dist/userScript.js + try APK via Docker
#   ./scripts/sync-cobalt.sh --wgt     # only build WGT (no Docker)
#   ./scripts/sync-cobalt.sh --apk     # only build APK (requires Docker)
#   ./scripts/sync-cobalt.sh --no-sync # skip git fetch/rebase, just build

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COBALT_DIR="${COBALT_DIR:-/tmp/TizenTubeCobalt}"
UPSTREAM_TIZENTUBE="https://github.com/reisxd/TizenTube.git"
UPSTREAM_COBALT="https://github.com/reisxd/TizenTubeCobalt.git"

MODE="all"
NO_SYNC=0
for arg in "$@"; do
  case "$arg" in
    --wgt) MODE="wgt" ;;
    --apk) MODE="apk" ;;
    --no-sync) NO_SYNC=1 ;;
    *) echo "unknown arg: $arg"; exit 1 ;;
  esac
done

log(){ echo -e "\033[1;34m[$(date +%H:%M:%S)]\033[0m $*"; }
warn(){ echo -e "\033[1;33m[WARN]\033[0m $*"; }
err(){ echo -e "\033[1;31m[ERR]\033[0m $*"; }

# --- 1. Sync youtube-blocky (this repo) with upstream TizenTube ---
sync_self(){
  [[ $NO_SYNC -eq 1 ]] && { log "skip sync (self)"; return; }
  log "Syncing youtube-blocky with $UPSTREAM_TIZENTUBE ..."
  if ! git remote | grep -q upstream; then
    git remote add upstream "$UPSTREAM_TIZENTUBE"
    log "added remote upstream"
  fi
  git fetch upstream --tags --prune || warn "fetch upstream failed (offline?)"
  # try rebase, fallback to merge if rebase fails
  if git rebase upstream/main 2>/dev/null || git rebase upstream/master 2>/dev/null; then
    log "rebased onto upstream"
  else
    warn "rebase failed, trying merge"
    git rebase --abort 2>/dev/null || true
    git merge upstream/main --no-ff -m "sync: merge upstream $(date -I)" || git merge upstream/master --no-ff -m "sync: merge upstream $(date -I)" || warn "merge also failed — resolve manually"
  fi
  git config rerere.enabled true 2>/dev/null || true
}

# --- 2. Build dist/userScript.js ---
build_mods(){
  log "Building mods/dist/userScript.js ..."
  if [[ ! -d "$ROOT/mods" ]]; then err "mods/ not found"; return 1; fi
  (cd "$ROOT/mods" && npm install --silent && npm run build)
  log "built $(du -h "$ROOT/dist/userScript.js" | cut -f1) dist/userScript.js"
}

# --- 3. Sync & patch Cobalt ---
sync_cobalt(){
  [[ $NO_SYNC -eq 1 ]] && { log "skip sync (cobalt)"; return; }
  if [[ ! -d "$COBALT_DIR/.git" ]]; then
    log "Cloning TizenTubeCobalt to $COBALT_DIR ..."
    git clone --depth 1 "$UPSTREAM_COBALT" "$COBALT_DIR"
  fi
  log "Syncing Cobalt ..."
  git -C "$COBALT_DIR" remote add tizentube-upstream "$UPSTREAM_COBALT" 2>/dev/null || true
  git -C "$COBALT_DIR" fetch tizentube-upstream --tags --prune || warn "fetch cobalt failed"
  git -C "$COBALT_DIR" rebase tizentube-upstream/main 2>/dev/null || git -C "$COBALT_DIR" rebase tizentube-upstream/master 2>/dev/null || warn "cobalt rebase failed"

  # Copy blocklist patch — find where Cobalt vendors mods
  log "Patching Cobalt with blocklist ..."
  # Try common locations; first hit wins, else copy to dist
  DESTS=(
    "$COBALT_DIR/cobalt/browser/h5vcc_tizentube/dist"
    "$COBALT_DIR/third_party/blink/renderer/modules/cobalt/h5vcc_tizen_tube"
    "$COBALT_DIR"
  )
  for f in mods/config.js mods/features/adblock.js mods/features/blocklist.js mods/resolveCommand.js mods/ui/settings.js mods/translations/resources/en.json; do
    SRC="$ROOT/$f"
    [[ -f "$SRC" ]] || continue
    # find dest file by basename
    DEST=$(find "$COBALT_DIR" -name "$(basename "$f")" -type f 2>/dev/null | head -1)
    if [[ -n "$DEST" ]]; then
      cp "$SRC" "$DEST"
      log "patched $DEST"
    else
      warn "no dest for $f — will patch dist only"
    fi
  done
  # Always ensure dist is up-to-date
  mkdir -p "$COBALT_DIR/cobalt/browser/h5vcc_tizentube/dist"
  cp "$ROOT/dist/userScript.js" "$COBALT_DIR/cobalt/browser/h5vcc_tizentube/dist/userScript.js" 2>/dev/null || true
}

# --- 4. Build WGT (Tizen) ---
build_wgt(){
  log "Building WGT (Tizen) ..."
  if ! command -v tizen >/dev/null 2>&1 && ! command -v tizenjs >/dev/null 2>&1; then
    warn "tizen CLI not found — skipping WGT (install Tizen Studio or npm i -g @vercel/ncc tizen.js)"
    warn "You can still sideload via TizenBrew: dist/userScript.js is ready"
    return 0
  fi
  (cd "$ROOT/standalone/service" && npm install --silent && npm run build 2>&1 | tail -n 20)
  mkdir -p "$ROOT/standalone/release"
  if command -v tizenjs >/dev/null 2>&1; then
    (cd "$ROOT/standalone" && tizenjs build . -t wgt -o release/TizenTubeCobalt-Blocklist.wgt --author "$ROOT/TizenTube-author.p12" -p public --ignore node_modules 2>&1 | tail -n 30) || warn "tizenjs build failed — check cert"
  else
    (cd "$ROOT/standalone" && tizen build-web -e "node_modules,*.wgt,userwidget,release" && tizen package -t wgt -o release --sign "$ROOT/TizenTube-author.p12" 2>&1 | tail -n 30) || warn "tizen build failed"
  fi
  ls -lh "$ROOT/standalone/release/" 2>/dev/null || true
}

# --- 5. Build APK (Cobalt Docker) ---
build_apk(){
  if [[ ! -d "$COBALT_DIR" ]]; then warn "COBALT_DIR not found, skipping APK"; return 0; fi
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not found — cannot build APK here."
    warn "On your machine: docker run --rm -v $COBALT_DIR:/workspace -w /workspace gcr.io/cobalt-dev/linux bash -c 'python cobalt/build/gn.py -p android-arm64 -c gold && autoninja -C out/android-arm64_gold cobalt/android:cobalt_apk'"
    warn "APK will be at: $COBALT_DIR/out/android-arm64_gold/cobalt/android/cobalt_apk.apk"
    # Still copy a ready-to-install dist for TizenBrew
    log "APK build skipped (no docker), but dist/userScript.js is ready for TizenBrew"
    return 0
  fi
  log "Building APK via Docker (android-arm64 gold) — this takes 30-60min first run, ~10min incremental ..."
  docker run --rm -v "$COBALT_DIR:/workspace" -w /workspace gcr.io/cobalt-dev/linux \
    bash -c "python cobalt/build/gn.py -p android-arm64 -c gold && autoninja -C out/android-arm64_gold cobalt/android:cobalt_apk"
  APK=$(find "$COBALT_DIR/out" -name "*.apk" 2>/dev/null | head -1)
  if [[ -n "$APK" ]]; then
    mkdir -p "$ROOT/release"
    cp "$APK" "$ROOT/release/TizenTubeCobalt-Blocklist.apk"
    log "APK ready: $ROOT/release/TizenTubeCobalt-Blocklist.apk ($(du -h "$ROOT/release/TizenTubeCobalt-Blocklist.apk" | cut -f1))"
    ls -lh "$ROOT/release/"
  else
    err "APK not found after build — check docker logs"
    find "$COBALT_DIR/out" -name "*.apk" 2>/dev/null | head -n 10 || true
  fi
}

# --- main ---
log "youtube-blocky sync + build — mode=$MODE"
sync_self
build_mods

case "$MODE" in
  wgt) build_wgt ;;
  apk) sync_cobalt; build_apk ;;
  all) sync_cobalt; build_wgt; build_apk ;;
esac

log "Done. Outputs:"
ls -lh "$ROOT/dist/userScript.js" 2>/dev/null || true
ls -lh "$ROOT/standalone/release/" 2>/dev/null || true
ls -lh "$ROOT/release/" 2>/dev/null || true
log "Next: adb install -r release/TizenTubeCobalt-Blocklist.apk  OR  sideload standalone/release/*.wgt via Apps2Samsung (12345 → Dev Mode)"
