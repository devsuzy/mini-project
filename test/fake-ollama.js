'use strict';
// 가짜 Ollama. 실모델 없이 프롬프트·스키마·tidy() 를 검증하기 위한 스텁이다.
//
// 이게 필요한 이유: ./test/run.sh 는 모델을 안 부르므로 프롬프트를 고쳐도 아무것도
// 잡아주지 못하고, node test/e2e.js 는 실모델이라 한 번에 45~236초가 든다.
// 그 사이에 구멍이 있다 — "모델에게 실제로 뭐가 나갔는가"와 "이상한 응답이 오면
// tidy() 가 막아주는가"는 모델 품질과 무관한데도 확인할 방법이 없었다.
//
// 라이브러리로:
//   const { start } = require('./fake-ollama.js');
//   const fake = await start();
//   fake.reply({ unanswered: [...] });   // 다음 /api/chat 이 돌려줄 객체 (큐)
//   fake.replyRaw('not json');           // content 를 문자열 그대로 (깨진 JSON 재현)
//   fake.fail(404);                      // HTTP 오류 재현
//   fake.last().options.num_ctx          // 모델에게 실제로 나간 요청
//   await fake.stop();
//
// 단독 실행으로 (UI 작업용 — 모델 없이 화면이 즉시 채워진다):
//   node test/fake-ollama.js 11500
//   OLLAMA_HOST=http://127.0.0.1:11500 npm start
//   또는 ./scripts/dev.sh start --fake

const http = require('node:http');

const DEFAULT_TAGS = [process.env.OLLAMA_MODEL || 'qwen2.5:7b'];

// ── 요청 안의 후보 목록을 되돌려주는 응답을 만든다 ─────────────────────
// tidy() 가 후보 밖 항목을 전부 버리므로, 후보를 모르는 응답을 주면 UI 가 텅 빈다.
// server.js 가 조립하는 user 메시지 형식에 의존한다 (api/CLAUDE.md 참조).
function parseCandidates(user) {
  const lines = sectionLines(user, '[검토 대상 질문]');
  return lines.map((l) => {
    const a = l.indexOf(' / ');
    const b = l.indexOf(' / ', a + 3);
    if (a < 0 || b < 0) return null;
    return { at: l.slice(0, a), user: l.slice(a + 3, b), text: l.slice(b + 3) };
  }).filter(Boolean);
}

function parseFaqCandidates(user) {
  return sectionLines(user, '[반복 질문 후보]').map((l) => {
    const m = l.match(/^"(.*)" \((\d+)회/);
    return m ? { question: m[1], count: Number(m[2]) } : null;
  }).filter(Boolean);
}

function sectionLines(user, header) {
  const i = user.indexOf(header);
  if (i < 0) return [];
  const out = [];
  for (const line of user.slice(i).split('\n').slice(1)) {
    if (line.startsWith('[')) break;          // 다음 섹션
    if (line.startsWith('- ')) out.push(line.slice(2));
  }
  return out;
}

// 큐가 비었을 때 쓰는 기본 응답. 후보를 그대로 돌려주므로 tidy() 를 전부 통과한다.
function echoAnswer(user) {
  if (user.includes('[조각별 요약]')) {          // /api/reduce 는 스키마가 다르다
    return { summary: '(가짜 Ollama 합본 요약 — 실제 모델이 아닙니다)', faqs: [] };
  }
  const cands = parseCandidates(user);
  const faqs = parseFaqCandidates(user);
  return {
    unanswered: cands.map((c) => ({
      at: c.at, asker: c.user, question: c.text, action: '확인 후 답변하기 (가짜 응답)',
    })),
    notices: [],
    issues: [],
    faqs: faqs.map((f) => ({ question: f.question, count: f.count, answer: '' })),
    summary: `(가짜 Ollama 응답 — 실제 모델이 아닙니다. 미답변 후보 ${cands.length}건을 그대로 돌려줍니다.)`,
  };
}

function start(opts = {}) {
  const state = { tags: opts.tags || DEFAULT_TAGS, queue: [], calls: [] };

  const server = http.createServer((req, res) => {
    const send = (status, obj) => {
      const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    };

    if (req.method === 'GET' && req.url === '/api/tags') {
      return send(200, { models: state.tags.map((name) => ({ name })) });
    }

    if (req.method === 'POST' && req.url === '/api/chat') {
      let raw = '';
      req.setEncoding('utf8');                 // server.js 와 같은 이유 — 한글이 chunk 경계에서 깨진다
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* 못 읽어도 호출 자체는 기록한다 */ }
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const call = {
          model: body.model,
          stream: body.stream,
          format: body.format,
          options: body.options || {},
          system: (msgs.find((m) => m.role === 'system') || {}).content || '',
          user: (msgs.find((m) => m.role === 'user') || {}).content || '',
        };
        state.calls.push(call);

        const next = state.queue.shift();
        if (!next) return send(200, { message: { content: JSON.stringify(echoAnswer(call.user)) } });
        if (next.kind === 'fail') return send(next.status, next.body === undefined ? { error: '가짜 실패' } : next.body);
        return send(200, { message: { content: next.content } });
      });
      return;
    }

    send(404, { error: `가짜 Ollama: 모르는 경로 ${req.url}` });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        calls: state.calls,
        last() { return state.calls[state.calls.length - 1]; },
        // 큐에 쌓은 순서대로 하나씩 소비된다. 비면 echoAnswer 로 돌아간다.
        reply(obj) { state.queue.push({ kind: 'ok', content: JSON.stringify(obj) }); return this; },
        replyRaw(s) { state.queue.push({ kind: 'ok', content: s }); return this; },
        replyNothing() { state.queue.push({ kind: 'ok', content: '' }); return this; },
        fail(status, body) { state.queue.push({ kind: 'fail', status, body }); return this; },
        setTags(list) { state.tags = list; return this; },
        reset() { state.queue.length = 0; state.calls.length = 0; return this; },
        stop() { return new Promise((r) => server.close(() => r())); },
      });
    });
  });
}

module.exports = { start, echoAnswer, parseCandidates, parseFaqCandidates };

if (require.main === module) {
  const port = Number(process.argv[2]) || 11500;
  start({ port }).then((f) => {
    console.log(`가짜 Ollama: ${f.url}  (모델 ${DEFAULT_TAGS.join(', ')})`);
    console.log(`  OLLAMA_HOST=${f.url} npm start`);
    console.log('  응답은 요청 안의 후보 목록을 그대로 되돌려줍니다 — 실제 판정이 아닙니다.');
  }).catch((e) => { console.error(`가짜 Ollama 기동 실패: ${e.message}`); process.exit(1); });
}
