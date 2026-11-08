#!/bin/bash
# Re-apply all bundle patches + deploy runtime drivers after `npm i -g 9router`.
set -e
PKG="$(npm root -g)/9router"
STATE="$APPDATA/9router"
[ -d "$PKG" ] || { echo "9router not installed"; exit 1; }
node customizations/patches/reinstall-9router-fixes.js "$PKG"
mkdir -p "$STATE/runtime/muse"
cp customizations/runtime/9r-net-keeper.js "$STATE/runtime/"
cp -r customizations/patches/muse/. "$STATE/runtime/muse/"
echo "Done. Restart 9router (customizations/runtime/restart-9router.ps1) to load patches."
