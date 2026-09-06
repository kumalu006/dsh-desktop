#!/usr/bin/env bash
# Generate the app icon (icon.icns) and macOS tray template icons from the
# official DeepSeek Harness favicon — the monochrome whale glyph, kept black
# on transparent so it reads as "DeepSeek Harness" rather than the blue
# DeepSeek brand. Requires macOS `sips` + `iconutil`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAVICON="${DSH_FAVICON:-/Users/kuma/projects/deepseek-harness/apps/web/public/favicon.svg}"
BUILD="$ROOT/build"
ASSETS="$ROOT/assets"

mkdir -p "$BUILD" "$ASSETS"

# Extract the whale path and emit two SVGs: the black glyph for the app icon and
# a monochrome tray template glyph (name ends with "Template", so macOS adapts
# it to the menu bar's light/dark appearance).
node - "$FAVICON" "$BUILD" <<'NODE'
const fs = require('fs')
const src = fs.readFileSync(process.argv[2], 'utf8')
const m = src.match(/\bd="([^"]+)"/)
if (!m || !m[1].startsWith('M')) { console.error('could not extract whale path (got: ' + (m && m[1]) + ')'); process.exit(1) }
if (!m) { console.error('no path d found in favicon'); process.exit(1) }
const d = m[1]
const build = process.argv[3]

const app = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 50 50">
  <path d="${d}" fill="#000000"/>
</svg>`

const tray = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 50 50">
  <g transform="translate(3,3) scale(0.88)">
    <path d="${d}" fill="#000000"/>
  </g>
</svg>`

fs.writeFileSync(`${build}/app-icon-src.svg`, app)
fs.writeFileSync(`${build}/tray-src.svg`, tray)
console.log('wrote app-icon-src.svg and tray-src.svg')
NODE

# Rasterize the app icon at 1024 and build an .icns.
sips -s format png "$BUILD/app-icon-src.svg" --out "$BUILD/icon-1024.png" >/dev/null
ICONSET="$BUILD/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$BUILD/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
done
for s in 32 64 256 512; do
  d=$((s * 2))
  sips -z "$d" "$d" "$BUILD/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
cp "$BUILD/icon-1024.png" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$BUILD/icon.icns"

# Tray template glyphs: 16x16 (1x) + 32x32 (@2x), both crisp so the menu-bar
# icon sits at the standard 16pt size instead of looking oversized/blurry.
sips -s format png "$BUILD/tray-src.svg" --out "$ASSETS/trayTemplate@2x.png" >/dev/null
sips -z 16 16 "$ASSETS/trayTemplate@2x.png" --out "$ASSETS/trayTemplate.png" >/dev/null

echo "done: build/icon.icns, assets/trayTemplate.png, assets/trayTemplate@2x.png"
