#!/usr/bin/env node
// TDD 가드 — PreToolUse(Write|Edit|MultiEdit) 훅.
//
// 규칙 하나다: 테스트 스위트가 전부 통과 중(GREEN)이면 소스 파일을 못 고친다.
// 실패하는 테스트(RED)가 있어야 구현이 열린다. 테스트 파일은 언제나 열려 있다.
//
// 판정을 못 하는 상황(러너 없음, 파싱 실패, 대상 불명)에서는 전부 통과시킨다.
// 가드가 조용히 개발을 막아버리는 것보다 한 번 놓치는 편이 낫다.
//
// 우회: TDD_GUARD=off 환경변수, 또는 `touch .claude/tdd-guard-off`

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// macOS 는 파일명을 NFD 로 돌려주는데(경로에 한글이 있으면 티가 난다) 훅이 넘겨주는
// file_path 는 NFC 다. 정규화를 안 맞추면 path.relative 가 같은 경로를 '..' 로 판정해서
// 가드가 저장소 안의 파일을 전부 '바깥'으로 흘려보낸다 (실제로 그랬다).
const nfc = (s) => s.normalize('NFC')
const ROOT = nfc(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
const RUNNER = path.join(ROOT, 'test', 'run.sh')
const OFF_SWITCH = path.join(ROOT, '.claude', 'tdd-guard-off')

const WATCHED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.html'])

// 소스가 아닌 것들 — 문서·설정·샘플 데이터·테스트·훅 자신.
const EXEMPT_DIR = /^(test|\.claude|\.git|node_modules)\//

function pass() { process.exit(0) }                       // 출력 없음 = 판단 보류, 평소 권한 흐름대로

function block(reason) {
  // writeSync 여야 한다. 훅의 stdout 은 파이프고, 파이프에서 process.stdout.write 는
  // 비동기라 곧바로 이어지는 process.exit() 가 버퍼를 통째로 날린다 (실제로 그랬다).
  writeSync(1, JSON.stringify({
    systemMessage: `🔴 TDD 가드: ${reason.split('\n')[0]}`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

let payload
try {
  payload = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  pass()                                                  // stdin 이 깨졌으면 판정 불가
}

if (!WATCHED_TOOLS.has(payload?.tool_name)) pass()
if (process.env.TDD_GUARD === 'off') pass()
if (existsSync(OFF_SWITCH)) pass()

const filePath = payload?.tool_input?.file_path
if (!filePath) pass()

const rel = path.relative(ROOT, nfc(path.resolve(filePath)))
if (rel.startsWith('..') || path.isAbsolute(rel)) pass()  // 저장소 밖은 관심 없다
if (EXEMPT_DIR.test(rel)) pass()
if (!SOURCE_EXT.has(path.extname(rel))) pass()
if (!existsSync(RUNNER)) pass()                           // 러너가 없으면 판정 불가

const run = spawnSync('/bin/sh', [RUNNER], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
if (run.error || run.status === null) pass()              // 러너가 못 돌면 판정 불가
if (run.status !== 0) pass()                              // RED — 구현해서 통과시키러 가는 길이다

const tail = (run.stdout || '').trim().split('\n').slice(-1)[0].replace(/\x1b\[[0-9;]*m/g, '')

block(
  `${rel} 를 고치기 전에 실패하는 테스트가 필요하다. 지금 스위트는 전부 통과 중이다 (${tail}).\n` +
  `\n` +
  `순서:\n` +
  `  1. test/parser.test.js 에 이번 변경이 만족시켜야 할 테스트를 먼저 추가한다\n` +
  `  2. ./test/run.sh 로 그 테스트가 실제로 실패하는지 확인한다 (RED)\n` +
  `  3. 그 다음 ${rel} 를 고친다 — 가드가 열린다\n` +
  `\n` +
  `테스트로 잡을 수 없는 변경(<script id="ui"> 의 DOM 바인딩, 프롬프트 문구, 주석)이면\n` +
  `사용자에게 확인받고 \`touch .claude/tdd-guard-off\` 로 잠시 끈 뒤 작업하고 다시 켠다.`
)
