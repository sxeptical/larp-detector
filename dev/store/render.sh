#!/bin/sh
# Renders the Web Store listing art from dev/store/shots.html into dist/store/
# as 24-bit PNGs (no alpha), using any local Chromium (Chrome, Helium, ...).
set -e
cd "$(dirname "$0")/../.."
CHROME="${CHROME:-$(ls -d /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome /Applications/Helium.app/Contents/MacOS/Helium 2>/dev/null | head -1)}"
[ -x "$CHROME" ] || { echo "set CHROME to a Chromium binary" >&2; exit 1; }
OUT=dist/store
mkdir -p "$OUT"
PAGE="file://$PWD/dev/store/shots.html"
shoot() { # name shot width height
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --force-device-scale-factor=1 --blink-settings=preferredColorScheme=1 --window-size="$3,$4" --virtual-time-budget=3000 \
    --screenshot="$PWD/$OUT/$1.png" "$PAGE?shot=$2" >/dev/null 2>&1
}
shoot screenshot-1-feed feed 1280 800
shoot screenshot-2-why why 1280 800
shoot screenshot-3-popup popup 1280 800
shoot promo-tile-440x280 tile 440 280
# Flatten to RGB: the store rejects PNGs with an alpha channel.
python3 - "$OUT" <<'PY'
import sys, glob
from PIL import Image
for p in glob.glob(f"{sys.argv[1]}/*.png"):
    im = Image.open(p).convert("RGB"); im.save(p); print(p, im.size, im.mode)
PY
