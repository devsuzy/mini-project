#!/bin/sh
set -e
cd "$(dirname "$0")/.."
node --check server.js 2>/dev/null || true
./test/extract-core.sh > /tmp/kakao-core-check.js && node --check /tmp/kakao-core-check.js
node test/parser.test.js
