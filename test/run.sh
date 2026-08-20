#!/bin/sh
# 단위 검증 전체. 모델이 필요 없고 1초 안에 끝난다.
#   ./test/run.sh
set -e
cd "$(dirname "$0")/.."

# node --check 의 실패를 삼키면 안 된다. 예전에는 `|| true` 가 붙어 있어서
# server.js 가 문법적으로 깨져도 "64 passed" 로 초록불이 났고, TDD 가드가 그걸
# GREEN 으로 읽어 정작 고치러 가는 편집을 막았다.
node --check server.js

./test/extract-core.sh > /tmp/kakao-core-check.js && node --check /tmp/kakao-core-check.js
node test/parser.test.js      # 파서·필터·탐지·병합 (브라우저 코어)
node test/server.test.js      # 프롬프트·스키마·tidy (가짜 Ollama)
node test/guard.test.js       # TDD 가드의 쓰기 판정
