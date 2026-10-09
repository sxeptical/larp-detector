#!/bin/sh
# Builds the store uploads: only the files the extension loads.
#   dist/larp-detector-<v>.zip          Chrome Web Store
#   dist/larp-detector-<v>-firefox.zip  addons.mozilla.org (manifest adapted)
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
FILES="background content lib ui icons"
mkdir -p dist

# --- Chrome -------------------------------------------------------------------
OUT="dist/larp-detector-$VERSION.zip"
rm -f "$OUT"
zip -rq "$OUT" manifest.json $FILES -x '*.DS_Store'
echo "$OUT"

# --- Firefox ------------------------------------------------------------------
# Firefox MV3 has no background service workers: the same module runs as an
# event-page background script. AMO also requires a gecko id and a
# data-collection declaration. Host permissions are granted at install from
# Firefox 127 on, hence the minimum version.
STAGE=$(mktemp -d)
cp -R $FILES "$STAGE/"
node -e '
  const m = require("./manifest.json");
  m.background = { scripts: [m.background.service_worker], type: "module" };
  m.browser_specific_settings = {
    gecko: {
      id: "larp-detector@sxeptical",
      strict_min_version: "128.0",
      data_collection_permissions: { required: ["websiteContent"] },
    },
  };
  require("fs").writeFileSync(process.argv[1] + "/manifest.json", JSON.stringify(m, null, 2) + "\n");
' "$STAGE"
OUT_FF="$PWD/dist/larp-detector-$VERSION-firefox.zip"
rm -f "$OUT_FF"
(cd "$STAGE" && zip -rq "$OUT_FF" manifest.json $FILES -x '*.DS_Store')
rm -rf "$STAGE"
echo "dist/larp-detector-$VERSION-firefox.zip"
