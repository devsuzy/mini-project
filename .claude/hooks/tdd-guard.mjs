#!/usr/bin/env node
// TDD 가드 — PreToolUse(Write|Edit|MultiEdit|Bash) 훅.
//
// 규칙 하나다: 테스트 스위트가 전부 통과 중(GREEN)이면 소스 파일을 못 고친다.
// 실패하는 테스트(RED)가 있어야 구현이 열린다. 테스트 파일은 언제나 열려 있다.
//
// 판정을 못 하는 상황(러너 없음, 파싱 실패, 대상 불명)에서는 전부 통과시킨다.
// 가드가 조용히 개발을 막아버리는 것보다 한 번 놓치는 편이 낫다.
//
// 우회: TDD_GUARD=off 환경변수, 또는 `touch .claude/tdd-guard-off`
//       (훅은 명령을 실행하기 전에 평가하므로, 같은 Bash 호출 안에서 touch 해도 늦다)
//
// 판정 로직은 export 한다 — test/guard.test.js 가 프로세스를 띄우지 않고 부른다.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// macOS 는 파일명을 NFD 로 돌려주는데(경로에 한글이 있으면 티가 난다) 훅이 넘겨주는
// file_path 는 NFC 다. 정규화를 안 맞추면 path.relative 가 같은 경로를 '..' 로 판정해서
// 가드가 저장소 안의 파일을 전부 '바깥'으로 흘려보낸다 (실제로 그랬다).
const nfc = (s) => s.normalize('NFC')
const ROOT = nfc(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
const RUNNER = path.join(ROOT, 'test', 'run.sh')
const OFF_SWITCH = path.join(ROOT, '.claude', 'tdd-guard-off')

const WATCHED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Bash'])
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.html'])

// 소스가 아닌 것들 — 문서·설정·샘플 데이터·테스트·훅 자신.
const EXEMPT_DIR = /^(test|\.claude|\.git|node_modules)\//

// 저장소 안의 소스 파일만 남긴다.
export function sourcePaths(candidates) {
  const out = []
  for (const c of candidates) {
    if (!c) continue
    const rel = path.relative(ROOT, nfc(path.resolve(ROOT, c)))
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue   // 저장소 밖은 관심 없다
    if (EXEMPT_DIR.test(rel)) continue
    if (!SOURCE_EXT.has(path.extname(rel))) continue
    out.push(rel)
  }
  return [...new Set(out)]
}

// Bash 로 파일을 쓰는 흔한 형태에서 대상 경로를 뽑는다.
//
// 이게 필요한 이유: 훅이 Write|Edit|MultiEdit 만 보던 동안, auto 모드의 편집은
// 전부 Bash 로 나갔다. 지난 8개 세션에서 Bash 192콜 중 90콜이 heredoc·node -e·
// python3 - 로 파일을 썼고, 가드는 그 전부를 통과시켰다.
//
// 경로는 반드시 "쓰기 구문에 직접 붙어 있을 때만" 센다. 명령문 어딘가에 그냥
// 등장하는 파일명은 세지 않는다 — 그렇게 했더니 heredoc 본문에 우연히 들어 있던
// 파일명 문자열 때문에 멀쩡한 명령이 막혔다 (실제로 그랬다).
//
// 정규식이라 완벽하지 않다 — 경로를 변수에 담아 넘기는 스크립트는 못 잡는다.
// 못 잡는 쪽으로 기울인다. 멀쩡한 명령을 막는 것보다 한 번 놓치는 편이 낫다.
// heredoc 본문은 데이터지 쉘 문법이 아니다. 본문까지 쉘 리다이렉션으로 읽었더니
// 문서에 예시로 적어둔 명령 한 줄 때문에 그 문서를 쓰는 것이 막혔다 (실제로 그랬다).
// 다만 본문이 python·node 스크립트인 경우는 그 안의 쓰기 호출이 진짜 쓰기이므로,
// 쓰기 API 검사만은 본문까지 포함해서 돌린다.
function stripHeredocs(cmd) {
  const out = []
  let delim = null
  for (const line of cmd.split('\n')) {
    if (delim === null) {
      out.push(line)
      const m = line.match(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/)
      if (m) delim = m[2]
    } else if (line.trim() === delim) {
      delim = null
    }
  }
  return out.join('\n')
}

export function bashWriteTargets(cmd) {
  if (typeof cmd !== 'string' || !cmd) return []
  const hits = []
  const add = (v) => { if (v) hits.push(v.replace(/^['"`]|['"`]$/g, '')) }
  const P = '[\\w./-]+\\.(?:js|mjs|cjs|html)'
  const Q = '[\'"`]'
  const shell = stripHeredocs(cmd)          // 쉘 문법은 본문을 뺀 것에서만 찾는다

  // 쉘 리다이렉션 — `> path`, `>> path`. `2>&1` 같은 fd 복제는 제외한다.
  for (const m of shell.matchAll(/(?<![0-9&])>>?\s*(?!&)(['"]?)([^\s'"|&;<>()]+)\1/g)) add(m[2])
  // tee [-a] path
  for (const m of shell.matchAll(/\btee\s+(?:-\S+\s+)*(['"]?)([^\s'"|&;]+)\1/g)) add(m[2])
  // cp/mv 의 목적지
  for (const m of shell.matchAll(/\b(?:cp|mv)\s+(?:-\S+\s+)*\S+\s+(['"]?)([^\s'"|&;]+)\1/g)) add(m[2])
  // sed -i — 제자리 편집이라 인자 중 소스 확장자를 가진 것이 곧 대상이다.
  // 반드시 그 sed 가 있는 절만 본다. 명령 전체를 긁었더니 뒤쪽 heredoc 본문에 있던
  // 파일명까지 대상으로 잡혔다 (실제로 그랬다).
  for (const seg of shell.split(/[\n;|&]+/)) {
    if (!/\bsed\s+(?:-\S+\s+)*-i/.test(seg)) continue
    for (const m of seg.matchAll(new RegExp(`(${P})\\b`, 'g'))) add(m[1])
  }
  // 임베드된 스크립트(node -e, python3 - <<PY)가 파일을 쓰는 경우.
  // 호출에 직접 붙은 리터럴만 본다.
  for (const re of [
    `(?:writeFileSync|copyFileSync|renameSync)\\(\\s*${Q}(${P})${Q}`,
    `\\bopen\\(\\s*${Q}(${P})${Q}\\s*,\\s*${Q}[wa]`,
    `readFileSync\\(\\s*${Q}(${P})${Q}`,          // 읽고-고쳐-쓰기 패치의 읽는 쪽
  ]) {
    for (const m of cmd.matchAll(new RegExp(re, 'g'))) add(m[1])
  }

  return sourcePaths(hits)
}

// 이 요청이 건드리는 소스 파일들. 감시 대상이 아니면 빈 배열.
export function targetsFor(payload) {
  if (!WATCHED_TOOLS.has(payload?.tool_name)) return []
  return payload.tool_name === 'Bash'
    ? bashWriteTargets(payload?.tool_input?.command)
    : sourcePaths([payload?.tool_input?.file_path])
}

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

function main() {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    pass()                                                // stdin 이 깨졌으면 판정 불가
  }

  if (!WATCHED_TOOLS.has(payload?.tool_name)) pass()
  if (process.env.TDD_GUARD === 'off') pass()
  if (existsSync(OFF_SWITCH)) pass()

  // 싼 검사가 먼저다. 쓰기처럼 안 보이는 명령은 스위트를 돌리지 않으므로 비용이 0이다.
  const targets = targetsFor(payload)
  if (!targets.length) pass()

  if (!existsSync(RUNNER)) pass()                         // 러너가 없으면 판정 불가

  const run = spawnSync('/bin/sh', [RUNNER], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 })
  if (run.error || run.status === null) pass()            // 러너가 못 돌면 판정 불가
  if (run.status !== 0) pass()                            // RED — 구현해서 통과시키러 가는 길이다

  const rel = targets.join(', ')
  const tail = (run.stdout || '').trim().split('\n').slice(-1)[0].replace(/\x1b\[[0-9;]*m/g, '')

  block(
    `${rel} 를 고치기 전에 실패하는 테스트가 필요하다. 지금 스위트는 전부 통과 중이다 (${tail}).\n` +
    `\n` +
    `순서:\n` +
    `  1. test/ 에 이번 변경이 만족시켜야 할 테스트를 먼저 추가한다\n` +
    `     · 파서·필터·탐지·병합 → test/parser.test.js\n` +
    `     · 프롬프트·스키마·tidy → test/server.test.js (가짜 Ollama, 모델 불필요)\n` +
    `  2. ./test/run.sh 로 그 테스트가 실제로 실패하는지 확인한다 (RED)\n` +
    `  3. 그 다음 ${rel} 를 고친다 — 가드가 열린다\n` +
    `\n` +
    `테스트로 잡을 수 없는 변경(<script id="ui"> 의 DOM 바인딩, 프롬프트 문구, 주석)이면\n` +
    `사용자에게 확인받고 \`touch .claude/tdd-guard-off\` 로 잠시 끈 뒤 작업하고 다시 켠다.`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
