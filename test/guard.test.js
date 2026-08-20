// TDD 가드의 "이 명령이 소스를 쓰는가" 판정 검증.
// 실제 세션 기록에서 뽑은 명령들이다. 오탐(멀쩡한 명령을 막는 것)이 미탐보다 위험하므로
// 통과해야 하는 케이스를 더 많이 넣었다.
//   node test/guard.test.js
//
// 가드를 프로세스로 띄우지 않고 import 해서 부른다 — 25콜이 0.0초다.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const guardPath = path.join(__dirname, '..', '.claude', 'hooks', 'tdd-guard.mjs');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? `\n      → ${extra}` : ''}`); }
};

let G;
const detect = (command, tool = 'Bash') =>
  G.targetsFor({ tool_name: tool, tool_input: tool === 'Bash' ? { command } : { file_path: command } });

(async () => {
  G = await import(pathToFileURL(guardPath).href);

  console.log('\n가드: 소스를 쓰는 Bash 명령을 잡는다');
  const CAUGHT = [
    ["cat > index.html <<'HTMLEOF'\n<!doctype html>\nHTMLEOF", 'heredoc 으로 index.html 통째 쓰기'],
    ["cat > server.js <<'EOF'\n'use strict';\nEOF", 'heredoc 으로 server.js 통째 쓰기'],
    ['echo "// 한 줄" >> server.js', '추가 리다이렉션(>>)'],
    [`node -e 'const fs=require("fs");let s=fs.readFileSync("server.js","utf8");fs.writeFileSync("server.js",s)'`,
      'node -e 읽고-고쳐-쓰기 패치'],
    [`sed -i '' "s/a/b/" index.html`, 'sed -i 제자리 편집'],
    ['cp /tmp/server.js.bak server.js', 'cp 로 소스 덮어쓰기'],
    ["python3 - <<'PY'\nopen('server.js','w').write('x')\nPY", 'python 스크립트가 소스를 씀'],
    ["sed -i '' 's/a/b/' index.html", 'sed -i 는 그 절 안의 소스는 잡는다'],
  ];
  for (const [cmd, name] of CAUGHT) {
    ok(detect(cmd).length > 0, name, `대상을 못 찾음: ${JSON.stringify(cmd.slice(0, 60))}`);
  }

  console.log('\n가드: 멀쩡한 명령은 통과시킨다 (오탐이 더 위험하다)');
  const PASSED = [
    ['node --check server.js', '문법 검사 — 읽기만 한다'],
    ['./test/run.sh 2>&1 | tail -3', '테스트 실행 (2>&1 을 리다이렉션으로 오인하면 안 된다)'],
    ['grep -n "innerHTML" index.html', 'grep — 읽기만 한다'],
    ['git add server.js && git commit -m "x"', 'git 스테이징'],
    ['cat index.html | head -20', '파이프로 읽기'],
    ["cat > test/parser.test.js <<'EOF'\nx\nEOF", '테스트 파일은 언제나 열려 있다'],
    ["cat > CLAUDE.md <<'EOF'\n# 문서\nEOF", '문서는 소스가 아니다'],
    ["cat > scripts/dev.sh <<'EOF'\n#!/bin/sh\nEOF", '.sh 는 소스 확장자가 아니다'],
    ["cat > .claude/hooks/tdd-guard.mjs <<'EOF'\nx\nEOF", '가드 자신은 면제된다'],
    ['npm start > /tmp/kakao-server.log 2>&1 &', '로그 리다이렉션 — 대상이 저장소 밖'],
    ['node test/e2e.js > /tmp/big-run.txt', '결과를 임시파일로'],
    ['cp server.js /tmp/server.js.bak', '백업 — 목적지가 저장소 밖'],
    ['./scripts/dev.sh restart --fake', '개발 서버 재시작'],
    ['ls -la && cat package.json', '탐색'],
    ["cat > CLAUDE.md <<'MDEOF'\n예시:\n  cat > server.js <<EOF\n  ...\n  EOF\nMDEOF",
      '문서 본문에 예시로 적힌 쉘 명령은 쓰기가 아니다'],
    ["cat > api/CLAUDE.md <<'MDEOF'\nsed -i '' 's/a/b/' index.html 로 고친다\nMDEOF",
      '문서 본문의 sed -i 예시도 쓰기가 아니다'],
    // ↓ 이 두 개가 실제로 가드를 잘못 발동시켰다. 회귀 방지.
    ["python3 - <<'PY'\np='test/guard.test.js'\ns=\"const g = path.join(d,'tdd-guard.mjs');\"\nopen(p,'w').write(s)\nPY",
      '테스트 파일을 쓰는데 본문에 우연히 소스 파일명이 들어 있다'],
    ["cat > CLAUDE.md <<'EOF'\nserver.js 를 고치기 전에 api/CLAUDE.md 를 읽을 것.\nEOF",
      '문서 본문이 소스 파일명을 언급한다'],
    ["sed -i '' 's/a/b/' notes.txt; cat > README.md <<'EOF'\nserver.js 설명\nEOF",
      'sed -i 가 있어도 다른 절의 파일명까지 긁지 않는다'],
  ];
  for (const [cmd, name] of PASSED) {
    ok(detect(cmd).length === 0, name, `잘못 걸림: ${JSON.stringify(detect(cmd))}`);
  }

  console.log('\n가드: Write/Edit 경로 판정은 그대로다');
  ok(detect(path.join(__dirname, '..', 'server.js'), 'Write').length === 1, 'Write 로 server.js → 감시 대상');
  ok(detect(path.join(__dirname, 'parser.test.js'), 'Write').length === 0, 'Write 로 test/ 파일 → 면제');
  ok(detect('/etc/hosts', 'Write').length === 0, '저장소 밖 절대경로 → 관심 없음');
  ok(detect(path.join(__dirname, '..', 'CLAUDE.md'), 'Write').length === 0, '문서 → 면제');
  ok(detect('echo hi', 'Read').length === 0, '감시 대상이 아닌 도구는 무시');

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})();
