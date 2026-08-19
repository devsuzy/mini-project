'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 5178;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const INDEX_HTML = path.join(__dirname, 'index.html');

// num_ctx 와 입력 상한은 한 몸이다. Ollama 기본 num_ctx 는 2048 이고,
// 넘치면 에러 없이 조용히 잘라낸다 — 그래서 명시하고, 상한을 여기서 역산한다.
//   16384 토큰 - 시스템 프롬프트 ~900 - 출력 여유 ~2500 ≈ 입력 13000 토큰
//   한국어는 대략 문자당 1토큰이 안 되지만 안전하게 1:1 로 보고 6000자로 끊는다.
//   index.html 의 CHUNK_CHARS 와 반드시 함께 움직여야 한다.
const NUM_CTX = 16384;
const MAX_INPUT_CHARS = 6000;
const MAX_BODY_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 180_000; // 첫 요청은 모델을 메모리에 올리느라 수십 초 걸린다

// Ollama 는 이 스키마를 GBNF 문법으로 컴파일해서 출력 "형태" 만 강제한다.
// 주의 1: 스키마의 description 은 모델에게 전달되지 않는다.
//         필드가 무슨 의미인지는 반드시 systemPrompt() 안에 있어야 한다.
// 주의 2: properties 의 순서가 곧 생성 순서다. summary 를 앞에 두었더니
//         모델이 요약을 쓰고 나서 "할 말 다 했다" 는 듯 뒤쪽 배열을 비워서 돌려줬다.
//         (실제로 issues/faqs 가 통째로 빈 채로 나왔다.) 그래서 배열을 먼저 채우게 하고
//         summary 를 맨 뒤로 옮겼다. 순서를 되돌리기 전에 이 문장을 볼 것.
const ANALYZE_SCHEMA = {
  type: 'object',
  properties: {
    unanswered: {
      type: 'array',
      items: {
        type: 'object',
        properties: { at: { type: 'string' }, asker: { type: 'string' }, question: { type: 'string' }, action: { type: 'string' } },
        required: ['at', 'asker', 'question', 'action'],
      },
    },
    notices: {
      type: 'array',
      items: {
        type: 'object',
        properties: { at: { type: 'string' }, topic: { type: 'string' }, detail: { type: 'string' } },
        required: ['at', 'topic', 'detail'],
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: { at: { type: 'string' }, signal: { type: 'string' }, detail: { type: 'string' }, severity: { type: 'string' } },
        required: ['at', 'signal', 'detail', 'severity'],
      },
    },
    faqs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { question: { type: 'string' }, count: { type: 'integer' }, answer: { type: 'string' } },
        required: ['question', 'count', 'answer'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['unanswered', 'notices', 'issues', 'faqs', 'summary'],
};

const REDUCE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    faqs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { question: { type: 'string' }, count: { type: 'integer' } },
        required: ['question', 'count'],
      },
    },
  },
  required: ['summary', 'faqs'],
};

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 7B 급 로컬 모델은 날짜 산술을 자주 틀린다. 계산 대신 "표에서 찾기" 로 바꿔주면 정확도가 크게 오른다.
function dateReference() {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));

  const lines = [];
  for (let i = 0; i < 21; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const week = i < 7 ? '이번 주' : i < 14 ? '다음 주' : '다다음 주';
    const mark = ymd(d) === ymd(today) ? ' ← 오늘' : '';
    lines.push(`${ymd(d)} = ${week} ${DAY_NAMES[d.getDay()]}요일${mark}`);
  }
  return lines.join('\n');
}

function systemPrompt(me) {
  const today = new Date();
  const owner = me && me.trim() ? me.trim() : '방장';
  return [
    `당신은 단체 채팅방을 관리하는 "${owner}" 을(를) 돕는 도구입니다.`,
    '입력은 카카오톡 그룹채팅 대화 원문이고, 각 줄은 [YYYY-MM-DD HH:MM] 이름: 내용 형식입니다.',
    '',
    `오늘은 ${ymd(today)} (${DAY_NAMES[today.getDay()]}요일)입니다.`,
    '',
    '[날짜 참고표] 상대 표현은 반드시 이 표에서 찾아 실제 날짜로 바꿉니다.',
    dateReference(),
    '',
    '[출력 형식] 아래 구조의 JSON 만 출력합니다. 설명이나 다른 문장을 덧붙이지 않습니다.',
    '{"unanswered":[{"at":"<YYYY-MM-DD HH:MM>","asker":"<질문한 사람>","question":"<질문 내용>","action":"<방장이 할 일>"}],',
    ' "notices":[{"at":"<YYYY-MM-DD HH:MM>","topic":"<공지 제목>","detail":"<공지 내용>"}],',
    ' "issues":[{"at":"<YYYY-MM-DD HH:MM>","signal":"<이슈 한 줄>","detail":"<상황 설명>","severity":"<high 또는 mid 또는 low>"}],',
    ' "faqs":[{"question":"<반복된 질문>","count":<반복 횟수>,"answer":"<대화에 나온 답. 없으면 빈 문자열>"}],',
    ' "summary":"<요약>"}',
    '위 꺾쇠 안의 내용은 자리표시자입니다. 그 글자를 그대로 출력하지 말고,',
    '반드시 입력된 대화에서 읽은 내용으로만 채웁니다.',
    '배열 네 개를 먼저 채우고, summary 는 마지막에 씁니다.',
    '',
    '[필드 규칙]',
    '- unanswered: 아래 [검토 대상 질문] 에 나열된 것만 판정합니다. 목록에 없는 질문을 새로 만들지 않습니다.',
    '  실제로 누군가의 응답이 필요한 질문이면 넣고, 혼잣말이나 인사치레면 넣지 않습니다.',
    `  action 은 "${owner}" 이(가) 직접 할 일을 명령형 한 문장으로 씁니다.`,
    `  action 의 주어는 항상 "${owner}" 입니다. 질문한 사람에게 무엇을 시키라고 쓰지 않습니다.`,
    '  예: 워크샵 장소를 확정해 공유하기. / 계약서 양식 위치를 안내하기.',
    '  질문한 사람의 이름을 action 의 주어로 쓰면 틀린 것입니다.',
    '  at 과 asker 는 [검토 대상 질문] 에 적힌 값을 그대로 옮깁니다. 바꾸지 않습니다.',
    '',
    '- notices: 방장이 공지로 올리거나 고정해두면 반복 설명이 줄어들 내용입니다.',
    '  결정 사항, 자료 위치, 일정 확정처럼 여러 사람이 알아야 하는 것만 넣습니다.',
    '  누군가 "공지할게요", "고정해둘게요", "정리해서 올릴게요" 라고 말한 대목은 반드시 넣습니다.',
    '',
    '- issues: 방장이 개입을 고려해야 할 신호입니다. 판단이 애매하면 넣지 않습니다.',
    '  넣는 것:',
    '  · 여러 사람이 반복해서 말하는 피로, 업무량 과다, 불편 호소',
    '  · 사람 사이의 마찰, 서운함, 언성이 높아진 대목',
    '  · 광고, 스팸, 관련 없는 홍보, 방 규칙 위반',
    '  넣지 않는 것 (이것들은 이슈가 아닙니다):',
    '  · 일정 조율. 예를 들어 바빠서 다음 주에 하겠다는 말은 이슈가 아닙니다.',
    '  · 근황이나 진행 상황 공유. 야근했다거나 어디에 다녀왔다는 말은 이슈가 아닙니다.',
    '  · 자료나 정보를 공유한 것. 그것은 notices 에서 다룹니다.',
    '  · 한 사람이 한 번만 지나가듯 말한 것.',
    '  severity: high 는 지금 개입하지 않으면 커지는 일, mid 는 두 명 이상이 같은 불편을 말한 일,',
    '  low 는 기록만 해둘 일입니다. high, mid, low 중 하나를 정확히 그 철자로 씁니다.',
    '  해당하는 신호가 없으면 빈 배열 [] 을 씁니다. 억지로 채우지 않습니다.',
    '',
    '- faqs: 아래 [반복 질문 후보] 에 나열된 것만 판정합니다. 목록에 없는 것을 새로 만들지 않습니다.',
    '  question 은 그 묶음을 대표하는 질문 한 문장으로 다듬고, count 는 주어진 횟수를 그대로 씁니다.',
    '  answer 는 대화 안에서 이미 나온 답을 옮겨 적습니다. 답이 대화에 없으면 빈 문자열 "" 로 둡니다.',
    '  대화에 없는 답을 지어내지 않습니다.',
    '',
    '- summary: 이 기간 대화에서 무슨 일이 있었는지 3~5문장으로 정리합니다.',
    '  누가 무엇을 공유했고 무엇이 결정됐는지 중심으로 씁니다. 잡담은 넣지 않습니다.',
    '',
    '[공통 규칙]',
    '- at 은 반드시 대화 원문에 실제로 있는 시각을 씁니다. 없는 시각을 지어내지 않습니다.',
    '- 대화에 근거가 없는 내용은 절대 만들지 않습니다. 해당 항목이 없으면 빈 배열 [] 을 씁니다.',
    '- 대화와 같은 언어(한국어)로 출력합니다.',
  ].join('\n');
}

function reducePrompt() {
  return [
    '당신은 여러 조각으로 나뉘어 요약된 채팅방 분석 결과를 하나로 합치는 도구입니다.',
    '',
    '[출력 형식] 아래 구조의 JSON 만 출력합니다.',
    '{"summary":"<전체 요약>","faqs":[{"question":"<반복된 질문>","count":<합산 횟수>}]}',
    '꺾쇠 안은 자리표시자입니다. 그 글자를 그대로 출력하지 말고 입력 내용으로 채웁니다.',
    '',
    '[규칙]',
    '- summary: 조각별 요약들을 시간 순서대로 읽고 전체를 5~8문장으로 다시 씁니다.',
    '  조각 요약을 단순히 이어 붙이지 말고, 중복을 걷어내고 흐름이 이어지게 다시 씁니다.',
    '- faqs: 표현만 다르고 같은 뜻인 질문끼리 하나로 묶고 count 를 더합니다.',
    '  묶은 뒤 count 가 2 미만인 항목은 버립니다.',
    '- 입력에 없는 내용을 새로 만들지 않습니다.',
  ].join('\n');
}

async function callOllama(system, user, schema) {
  let res;
  try {
    res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        format: schema,
        options: {
          temperature: 0,  // 추출 작업이라 같은 입력에 같은 결과가 나와야 한다
          num_ctx: NUM_CTX,
        },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error('모델 응답이 너무 오래 걸립니다. 분석 기간을 좁혀서 다시 시도해 주세요.');
    }
    throw new Error(`Ollama 에 연결하지 못했습니다. 터미널에서 "ollama serve" 가 실행 중인지 확인해 주세요. (${OLLAMA_HOST})`);
  }

  const raw = await res.text();
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`"${MODEL}" 모델이 없습니다. 터미널에서 "ollama pull ${MODEL}" 을 실행해 주세요.`);
    }
    let msg = `HTTP ${res.status}`;
    try { msg = JSON.parse(raw).error || msg; } catch { /* JSON 이 아니면 상태 코드만 */ }
    throw new Error(`Ollama 오류: ${msg}`);
  }

  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('Ollama 응답을 해석하지 못했습니다.'); }

  const content = data?.message?.content;
  if (!content) throw new Error('모델이 결과를 반환하지 않았습니다.');

  try { return JSON.parse(content); }
  catch { throw new Error('모델이 올바른 JSON 을 반환하지 않았습니다. 다시 시도해 주세요.'); }
}

// GBNF 는 형태만 강제하고 의미는 강제하지 않는다. 소형 모델은 필드를 비우거나
// 자리표시자를 그대로 뱉기도 해서 여기서 한 번 걸러낸다.
const PLACEHOLDER = /^<.*>$/;
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const clean = (v) => { const s = str(v); return PLACEHOLDER.test(s) ? '' : s; };

function tidy(parsed, allowedQuestions, allowedFaqs = []) {
  const dropped = { unanswered: 0, notices: 0, issues: 0, faqs: 0 };
  const arr = (v) => (Array.isArray(v) ? v : []);

  // 모델이 목록에 없는 질문을 지어내는 것을 막는다 — 후보는 규칙이 이미 확정했다.
  const allowed = new Set(allowedQuestions.map((q) => q.text));
  const unanswered = arr(parsed.unanswered).filter((x) => {
    const q = clean(x?.question);
    if (!q) { dropped.unanswered++; return false; }
    if (allowed.size && !allowed.has(q) && ![...allowed].some((a) => a.includes(q) || q.includes(a))) {
      dropped.unanswered++; return false;
    }
    return true;
  }).map((x) => ({
    at: clean(x.at), asker: clean(x.asker) || '알 수 없음',
    question: clean(x.question), action: clean(x.action) || '확인 후 답변하기',
  }));

  const notices = arr(parsed.notices).filter((x) => {
    if (!clean(x?.topic) || !clean(x?.detail)) { dropped.notices++; return false; }
    return true;
  }).map((x) => ({ at: clean(x.at), topic: clean(x.topic), detail: clean(x.detail) }));

  const issues = arr(parsed.issues).filter((x) => {
    if (!clean(x?.signal)) { dropped.issues++; return false; }
    return true;
  }).map((x) => ({
    at: clean(x.at), signal: clean(x.signal), detail: clean(x.detail),
    severity: ['high', 'mid', 'low'].includes(str(x.severity)) ? str(x.severity) : 'low',
  }));

  // faq 도 규칙이 만든 후보 안에서만 인정한다. count 는 모델 말 대신 규칙이 센 값을 쓴다.
  const faqs = arr(parsed.faqs).map((x) => {
    const q = clean(x?.question);
    if (!q) { dropped.faqs++; return null; }
    const src = allowedFaqs.find((f) => f.question === q)
      || allowedFaqs.find((f) => f.question.includes(q) || q.includes(f.question))
      || (allowedFaqs.length === 1 ? allowedFaqs[0] : null);
    if (!src) { dropped.faqs++; return null; }
    return { question: q, count: src.count, askers: src.askers || [], answer: clean(x.answer) };
  }).filter(Boolean);

  return { summary: clean(parsed.summary), unanswered, notices, issues, faqs, dropped };
}

async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { running: false, hasModel: false };
    const { models = [] } = await res.json();
    // 정확 매칭. 접두어로 보면 qwen2.5:3b 만 있어도 qwen2.5:7b 가 있다고 착각한다.
    const want = MODEL.includes(':') ? MODEL : `${MODEL}:latest`;
    const hasModel = models.some((m) => m.name === MODEL || m.name === want);
    return { running: true, hasModel };
  } catch {
    return { running: false, hasModel: false };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // setEncoding 없이 Buffer 를 문자열에 이어붙이면 UTF-8 한글이 chunk 경계에서 깨진다.
    req.setEncoding('utf8');
    let data = '', bytes = 0;
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) { reject(new Error('요청이 너무 큽니다.')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/config') {
    const status = await checkOllama();
    return sendJson(res, 200, { model: MODEL, ...status, maxInputChars: MAX_INPUT_CHARS });
  }

  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    try {
      const { transcript, me, candidates, faqCandidates } = JSON.parse((await readBody(req)) || '{}');
      if (!transcript || !transcript.trim()) return sendJson(res, 400, { error: '분석할 대화가 비어 있습니다.' });
      if (transcript.length > MAX_INPUT_CHARS * 1.2) {
        return sendJson(res, 400, { error: `대화 조각이 너무 깁니다 (${transcript.length}자). 청크 크기를 줄여 주세요.` });
      }

      const list = Array.isArray(candidates) ? candidates : [];
      const faqList = Array.isArray(faqCandidates) ? faqCandidates : [];
      const user = [
        '[대화 원문]',
        transcript,
        '',
        '[검토 대상 질문] — unanswered 는 이 목록에서만 고릅니다.',
        list.length
          ? list.map((c) => `- ${c.at} / ${c.user} / ${c.text}`).join('\n')
          : '(없음 — unanswered 는 빈 배열로 둡니다)',
        '',
        '[반복 질문 후보] — faqs 는 이 목록에서만 고릅니다.',
        faqList.length
          ? faqList.map((f) => `- "${f.question}" (${f.count}회, 질문한 사람: ${(f.askers || []).join(', ')})`).join('\n')
          : '(없음 — faqs 는 빈 배열로 둡니다)',
      ].join('\n');

      const parsed = await callOllama(systemPrompt(me), user, ANALYZE_SCHEMA);
      return sendJson(res, 200, tidy(parsed, list.map((c) => ({ text: c.text })), faqList));
    } catch (err) {
      console.error('[analyze]', err.message);
      return sendJson(res, 500, { error: err.message || '알 수 없는 오류가 발생했습니다.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/reduce') {
    try {
      const { summaries, faqs } = JSON.parse((await readBody(req)) || '{}');
      const list = Array.isArray(summaries) ? summaries.filter(Boolean) : [];
      if (!list.length) return sendJson(res, 400, { error: '합칠 요약이 없습니다.' });

      const user = [
        '[조각별 요약]',
        list.map((s, i) => `${i + 1}) ${s}`).join('\n\n'),
        '',
        '[조각별 반복 질문]',
        (Array.isArray(faqs) && faqs.length)
          ? faqs.map((f) => `- ${f.question} (${f.count}회)`).join('\n')
          : '(없음)',
      ].join('\n');

      const parsed = await callOllama(reducePrompt(), user, REDUCE_SCHEMA);
      return sendJson(res, 200, {
        summary: clean(parsed.summary),
        faqs: (Array.isArray(parsed.faqs) ? parsed.faqs : [])
          .filter((f) => clean(f?.question) && Number(f?.count) >= 2)
          .map((f) => ({ question: clean(f.question), count: Math.round(Number(f.count)) })),
      });
    } catch (err) {
      console.error('[reduce]', err.message);
      return sendJson(res, 500, { error: err.message || '알 수 없는 오류가 발생했습니다.' });
    }
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    // 매 요청마다 읽는다 — HTML 을 고쳐도 서버 재시작이 필요 없다.
    return fs.readFile(INDEX_HTML, (err, buf) => {
      if (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('index.html 을 읽지 못했습니다.');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

// 127.0.0.1 에만 바인딩한다. 기본값(0.0.0.0)이면 같은 Wi-Fi 의 다른 기기에서
// 남의 카톡 대화가 열린다 — UI 의 "밖으로 나가지 않습니다" 문구와 정면으로 어긋난다.
server.listen(PORT, '127.0.0.1', async () => {
  console.log(`\n  카톡 채팅 → 액션 아이템`);
  console.log(`  http://localhost:${PORT}`);
  const { running, hasModel } = await checkOllama();
  if (!running) console.log(`  ⚠️  Ollama 미실행 → 터미널에서 "ollama serve" 를 먼저 실행하세요.`);
  else if (!hasModel) console.log(`  ⚠️  모델 없음 → "ollama pull ${MODEL}" 을 실행하세요.`);
  else console.log(`  모델: ${MODEL} (로컬, 무료)`);
  console.log('');
});
