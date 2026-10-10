# Apply Blocklist to your TizenTubeCobalt fork (APK only)

Your fork: https://github.com/hussain-chachuliya/TizenTubeCobalt

This guide patches your fork with the blocklist feature (keywords + channels, auto-suggest, Block Channel on long-press & header) and builds the APK via the GitHub Action we added.

## Option A — One command (from your fork clone)

```bash
git clone https://github.com/hussain-chachuliya/TizenTubeCobalt.git
cd TizenTubeCobalt
git remote add upstream https://github.com/reisxd/TizenTubeCobalt.git
git fetch upstream

git checkout -b blocklist upstream/main

# Pull the blocklist patch from youtube-blocky (this repo)
SRC=/path/to/youtube-blocky   # or clone it
# If you don't have youtube-blocky locally, fetch the patch directly:
# curl -L https://github.com/<you>/youtube-blocky/raw/main/mods/features/blocklist.js -o /tmp/blocklist.js

for f in mods/config.js mods/features/blocklist.js mods/features/adblock.js \
         mods/resolveCommand.js mods/ui/settings.js mods/translations/resources/en.json; do
  SRC_FILE="$SRC/$f"
  DST=$(find . -name "$(basename $f)" -type f 2>/dev/null | head -1)
  if [[ -n "$DST" ]]; then
    cp "$SRC_FILE" "$DST" && echo "patched $DST"
  fi
done

# Always overlay the built bundle (most reliable for Cobalt)
mkdir -p cobalt/browser/h5vcc_tizentube/dist
cp "$SRC/dist/userScript.js" cobalt/browser/h5vcc_tizentube/dist/userScript.js

# Copy CI for APK builds
mkdir -p .github/workflows
cp "$SRC/.github/workflows/build-blocklist-apk.yaml" .github/workflows/

git add -A && git commit -m "feat(blocklist): channel & keyword blocking"
git push -u origin blocklist
```

Then on GitHub: **Actions → Build Blocklist APK & WGT → Run workflow** (check `build_apk`) → download `apk-blocklist` artifact.

Or tag a release:
```bash
git tag blocklist-v1.0.0 && git push origin blocklist-v1.0.0
# → Release with TizenTubeCobalt-Blocklist.apk attached
```

## Option B — Cherry-pick from youtube-blocky (if you added it as remote)

```bash
cd TizenTubeCobalt
git remote add blocklist-src https://github.com/<you>/youtube-blocky.git
git fetch blocklist-src
git cherry-pick <blocklist-commit-hash>  # ad254d1 + 8db43cd
# fix any small conflicts in adblock.js, then:
git push origin blocklist
```

## Stay up-to-date with upstream Cobalt

```bash
git fetch upstream
git rebase upstream/main   # or upstream/master
# if conflict in adblock.js: fix → git add → git rebase --continue
git push --force-with-lease
# rerere will auto-resolve the same adblock.js hook next time
```

Your `scripts/sync-cobalt.sh` does this automatically:
```bash
./scripts/sync-cobalt.sh --apk   # sync + Docker build android-arm64 gold
```

## Build APK locally (without GitHub)

Needs Docker (30GB disk, 45min first build):

```bash
./scripts/sync-cobalt.sh --apk
# or manually:
docker run --rm -v "$PWD:/workspace" -w /workspace gcr.io/cobalt-dev/linux \
  bash -c "python cobalt/build/gn.py -p android-arm64 -c gold && autoninja -C out/android-arm64_gold cobalt/android:cobalt_apk"
adb install -r out/android-arm64_gold/cobalt/android/cobalt_apk.apk
```

## Quick test without APK (TizenBrew)

You don't need an APK to test: install `dist/userScript.js` via TizenBrew Module Manager as `@yours/blocky` — same Blocklist UI, instant.

## Files changed (6 + 1 built)

- `mods/features/blocklist.js` (new)
- `mods/config.js` (+4 lines)
- `mods/features/adblock.js` (+filter + Block Channel hooks)
- `mods/resolveCommand.js` (+BLOCK_CHANNEL + SHOW_BLOCKLIST + search)
- `mods/ui/settings.js` (+Blocklist entry)
- `mods/translations/resources/en.json` (+blocklist i18n)
- `dist/userScript.js` (built)
