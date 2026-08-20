'use strict';
// 서버 계약 검증 — 프롬프트·스키마·tidy(). 가짜 Ollama 를 붙여서 돌리므로 모델이 필요 없다.
//   ./test/run.sh   (또는 node test/server.test.js)
//
// 여기서 잡는 것은 "모델 품질"이 아니라 그 앞뒤다:
//   ① 모델에게 실제로 무엇이 나갔는가 (스키마 순서·num_ctx·temperature·프롬프트 내용)
//   ② 모델이 이상한 걸 돌려줬을 때 tidy() 가 막아주는가
// 둘 다 모델과 무관하게 결정적이라, 실모델 e2e(45~236초) 없이 확인할 수 있어야 한다.

const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { start } = require('./fake-ollama.js');

const root = path.join(__dirname, '..');
const MODEL = 'qwen2.5:7b';

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? `\n      → ${extra}` : ''}`); }
};
const eq = (a, b, name) => ok(a === b, name, `기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`);

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function bootServer(port, ollamaHost) {
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), OLLAMA_HOST: ollamaHost, OLLAMA_MODEL: MODEL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  for (let i = 0; i < 100; i++) {                    // 최대 5초 대기
    if (child.exitCode !== null) throw new Error(`server.js 가 죽었다 (exit ${child.exitCode})\n${log}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return child;
    } catch { /* 아직 안 떴다 */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill('SIGKILL');
  throw new Error(`server.js 가 5초 안에 안 떴다\n${log}`);
}

// 본문을 한글 한 글자(3바이트) 한복판에서 쪼개 두 번에 나눠 보낸다.
// fetch 는 21KB 를 한 덩어리로 보내므로 chunk 경계가 아예 안 생긴다 — 그러면
// readBody 의 setEncoding 이 사라져도 테스트가 눈치채지 못한다 (실제로 그랬다).
const postSplit = (port, route, body) => new Promise((resolve, reject) => {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  let cut = Math.floor(buf.length / 2);
  while (cut < buf.length && (buf[cut] & 0xc0) !== 0x80) cut++;   // 이어지는 바이트(10xxxxxx) 한복판
  const req = http.request({
    host: '127.0.0.1', port, path: `/api/${route}`, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': buf.length },
  }, (res) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(raw), cut }); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.write(buf.subarray(0, cut));
  setTimeout(() => req.end(buf.subarray(cut)), 20);               // 별도 TCP 세그먼트로 나가게
});

const post = async (port, route, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

// 최소한의 정상 요청. 개별 테스트는 여기서 필요한 것만 덮어쓴다.
const CANDS = [{ at: '08-12 11:03', user: '박서연', text: '엑셀시트 구할 수 있을까요?' }];
const base = (over = {}) => ({
  transcript: '[08-12 11:03] 박서연: 엑셀시트 구할 수 있을까요?',
  me: '김태호팀장', candidates: CANDS, faqCandidates: [], ...over,
});

(async () => {
  const fake = await start({ tags: [MODEL] });
  const port = await freePort();
  let child;
  try {
    child = await bootServer(port, fake.url);

    // ── ① 모델에게 실제로 나가는 요청 ─────────────────────────────
    console.log('\n모델에게 나가는 요청');
    fake.reset();
    await post(port, 'analyze', base());
    const call = fake.last();

    eq(Object.keys(call.format.properties).join(','), 'unanswered,notices,issues,faqs,summary',
      'ANALYZE_SCHEMA 의 properties 순서가 유지된다 — summary 가 맨 뒤 (앞으로 가면 배열이 빈 채 온다)');
    eq(call.options.num_ctx, 16384, 'num_ctx 를 명시한다 (Ollama 기본 2048 은 에러 없이 잘라낸다)');
    eq(call.options.temperature, 0, 'temperature 0 — 추출 작업이라 결정적이어야 한다');
    eq(call.stream, false, 'stream: false');
    eq(call.model, MODEL, 'OLLAMA_MODEL 이 그대로 전달된다');
    ok(call.format.required.length === 5, 'required 에 5개 필드가 전부 있다');

    ok(/= 이번 주 [일월화수목금토]요일/.test(call.system),
      '시스템 프롬프트에 날짜 대조표가 깔린다 (7B 는 날짜 산술을 틀리지만 표에서 찾기는 잘한다)');
    ok(call.system.includes('김태호팀장'), 'me 가 방장 이름으로 시스템 프롬프트에 들어간다');
    ok(call.user.includes('엑셀시트 구할 수 있을까요?'), '검토 대상 질문 목록이 user 메시지에 실린다');

    fake.reset();
    await post(port, 'analyze', base({ me: '' }));
    ok(fake.last().system.includes('방장'), 'me 가 비면 "방장" 으로 대체된다');
    ok(fake.last().user.includes('(없음 — unanswered 는 빈 배열로 둡니다)') === false,
      '후보가 있으면 "(없음)" 문구가 안 나온다');

    fake.reset();
    await post(port, 'analyze', base({ candidates: [], faqCandidates: [] }));
    ok(fake.last().user.includes('(없음 — unanswered 는 빈 배열로 둡니다)'),
      '후보가 없으면 빈 배열로 두라고 명시해서 보낸다');

    // 한글이 chunk 경계에서 깨지지 않는가 (readBody 의 setEncoding)
    fake.reset();
    const long = '가나다라마바사아자차카타파하'.repeat(500);   // 7,000자 · UTF-8 21KB
    const r13 = await post(port, 'analyze', base({ transcript: long }));
    eq(r13.status, 200, '7,000자 한글 요청이 통과한다 (상한 7,200자)');

    fake.reset();
    const r14 = await postSplit(port, 'analyze', base({ transcript: long }));
    eq(r14.status, 200, '한글 한 글자 한복판에서 쪼개 보내도 200');
    ok(fake.last().user.includes(long),
      'chunk 경계에 걸친 한글이 깨지지 않는다 (readBody 의 setEncoding 회귀)',
      `${r14.cut}번째 바이트에서 절단`);

    // ── ② 입력 검증 — 모델을 부르기 전에 막는가 ────────────────────
    console.log('\n입력 검증 (모델 호출 전에 막아야 한다)');
    fake.reset();
    const tooLong = await post(port, 'analyze', base({ transcript: '가'.repeat(7300) }));
    eq(tooLong.status, 400, '상한(6000×1.2)을 넘으면 400');
    eq(fake.calls.length, 0, '길이 초과는 모델을 아예 부르지 않는다');

    fake.reset();
    const empty = await post(port, 'analyze', base({ transcript: '   ' }));
    eq(empty.status, 400, '빈 대화는 400');
    eq(fake.calls.length, 0, '빈 대화도 모델을 부르지 않는다');

    // ── ③ 모델이 이상한 걸 돌려줬을 때 tidy() 가 막는가 ────────────
    console.log('\ntidy() — 모델 출력을 후보 안에 가둔다');
    fake.reset();
    fake.reply({
      unanswered: [
        { at: '', asker: '박서연', question: '엑셀시트 구할 수 있을까요?', action: 'a' },
        { at: '', asker: '아무개', question: '모델이 지어낸 질문입니다', action: 'b' },
      ],
      notices: [], issues: [], faqs: [], summary: '요약',
    });
    const halluc = await post(port, 'analyze', base());
    eq(halluc.json.unanswered.length, 1, '후보 목록에 없는 질문은 버린다');
    eq(halluc.json.dropped.unanswered, 1, '버린 개수를 dropped 로 돌려준다 (UI 가 보여준다)');

    fake.reset();
    fake.reply({ unanswered: [{ at: '', asker: 'x', question: '엑셀시트 구할 수', action: '' }],
      notices: [], issues: [], faqs: [], summary: '' });
    const partial = await post(port, 'analyze', base());
    eq(partial.json.unanswered.length, 1, '후보의 부분 문자열은 인정한다 (모델이 문장을 다듬으므로)');
    eq(partial.json.unanswered[0].action, '확인 후 답변하기', 'action 이 비면 기본 문구로 채운다');

    fake.reset();
    fake.reply({ unanswered: [], notices: [], summary: '',
      issues: [{ at: '', signal: '이슈', detail: '', severity: 'critical' }], faqs: [] });
    const sev = await post(port, 'analyze', base());
    eq(sev.json.issues[0].severity, 'low', 'severity 가 high/mid/low 밖이면 low 로 떨어뜨린다');

    fake.reset();
    fake.reply({ unanswered: [], summary: '', issues: [], faqs: [],
      notices: [{ at: '', topic: '<주제>', detail: '<내용>' }] });
    const ph = await post(port, 'analyze', base());
    eq(ph.json.notices.length, 0, '자리표시자(<...>)만 남은 항목은 버린다');
    eq(ph.json.dropped.notices, 1, '자리표시자도 dropped 에 센다');

    fake.reset();
    fake.reply({ unanswered: [], notices: [], issues: [], summary: '',
      faqs: [{ question: '계약서 양식 어디 있나요?', count: 99, answer: '공유폴더' }] });
    const faq = await post(port, 'analyze',
      base({ faqCandidates: [{ question: '계약서 양식 어디 있나요?', count: 3, askers: ['A', 'B', 'C'] }] }));
    eq(faq.json.faqs[0].count, 3, 'faq count 는 모델 말(99)이 아니라 규칙이 센 값(3)으로 덮어쓴다');
    eq(faq.json.faqs[0].askers.length, 3, 'askers 는 규칙 쪽 값을 그대로 쓴다');

    fake.reset();
    fake.reply({ unanswered: [], notices: [], issues: [], summary: '',
      faqs: [{ question: '후보에 없는 반복질문', count: 2, answer: '' }] });
    const faqOut = await post(port, 'analyze', base({ faqCandidates: [] }));
    eq(faqOut.json.faqs.length, 0, '후보 밖 faq 는 버린다');

    fake.reset();
    fake.reply({});                                   // 배열이 통째로 없는 응답
    const bare = await post(port, 'analyze', base());
    eq(bare.status, 200, '필드가 통째로 빠져도 500 이 아니다');
    ok(Array.isArray(bare.json.issues) && bare.json.issues.length === 0, '빠진 배열은 빈 배열로 채운다');

    // ── ④ Ollama 쪽 장애가 사용자 문장으로 바뀌는가 ────────────────
    console.log('\n장애 처리 (사용자에게 보여줄 수 있는 문장인가)');
    fake.reset();
    fake.replyRaw('이건 JSON 이 아닙니다');
    const badJson = await post(port, 'analyze', base());
    eq(badJson.status, 500, '모델이 JSON 이 아닌 걸 뱉으면 500');
    ok(/JSON/.test(badJson.json.error), '깨진 JSON 은 한국어 안내로 바뀐다', badJson.json.error);

    fake.reset();
    fake.replyNothing();
    const noContent = await post(port, 'analyze', base());
    eq(noContent.status, 500, 'content 가 비면 500');
    ok(noContent.json.error.includes('반환하지 않았습니다'), '빈 응답 안내 문구', noContent.json.error);

    fake.reset();
    fake.fail(404);
    const notFound = await post(port, 'analyze', base());
    ok(notFound.json.error.includes(`ollama pull ${MODEL}`),
      '404 는 "ollama pull <model>" 조치 방법을 안내한다', notFound.json.error);

    fake.reset();
    fake.fail(500, { error: '모델이 터졌다' });
    const boom = await post(port, 'analyze', base());
    ok(boom.json.error.includes('모델이 터졌다'), 'Ollama 가 준 에러 메시지를 그대로 전달한다', boom.json.error);

    // ── ⑤ /api/reduce 와 /api/config ──────────────────────────────
    console.log('\n/api/reduce 와 /api/config');
    fake.reset();
    fake.reply({ summary: '합본 요약', faqs: [{ question: '두 번 나온 질문', count: 2 }, { question: '한 번', count: 1 }] });
    const red = await post(port, 'reduce', { summaries: ['a', 'b'], faqs: [] });
    eq(red.json.faqs.length, 1, 'reduce 는 count < 2 인 FAQ 를 버린다');
    eq(red.json.summary, '합본 요약', 'reduce 요약이 그대로 온다');
    eq(Object.keys(fake.last().format.properties).join(','), 'summary,faqs', 'REDUCE_SCHEMA 형태');

    const noSum = await post(port, 'reduce', { summaries: [], faqs: [] });
    eq(noSum.status, 400, '합칠 요약이 없으면 400');

    fake.setTags(['qwen2.5:3b']);                     // 접두어만 같은 다른 모델
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    eq(cfg.running, true, 'Ollama 가 살아있으면 running true');
    eq(cfg.hasModel, false, '모델 매칭은 정확 매칭 — 3b 만 있으면 7b 가 있다고 하지 않는다');
    eq(cfg.maxInputChars, 6000, 'maxInputChars 를 UI 에 알려준다');

    fake.setTags([MODEL]);
    const cfg2 = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    eq(cfg2.hasModel, true, '정확히 같은 태그면 hasModel true');
  } catch (err) {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m 스위트가 예외로 중단됐다\n      → ${err.stack || err.message}`);
  } finally {
    if (child) child.kill('SIGTERM');
    await fake.stop();
  }

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})();
