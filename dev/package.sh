#!/bin/sh
# Builds the Chrome Web Store upload: only the files the extension loads.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/larp-detector-$VERSION.zip"
mkdir -p dist
rm -f "$OUT"
zip -rq "$OUT" manifest.json background content lib ui icons -x '*.DS_Store'
echo "$OUT"
