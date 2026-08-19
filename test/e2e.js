'use strict';
// 샘플 CSV → 파싱 → 청킹 → 서버 분석까지 실제로 태워본다.
//   node test/e2e.js [csv경로] [내이름]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const core = execFileSync(path.join(__dirname, 'extract-core.sh'), { encoding: 'utf8' });
const C = {};
new Function('module', core)({ set exports(v) { Object.assign(C, v); }, get exports() { return C; } });

const PORT = process.env.PORT || 5178;
const file = process.argv[2] || path.join(__dirname, '..', 'sample-chat.csv');
const me = process.argv[3] || '김태호팀장';

(async () => {
  const msgs = C.toMessages(C.parseCsv(fs.readFileSync(file, 'utf8')));
  const kept = msgs.filter((m) => !m.noise);
  const cands = C.findUnansweredCandidates(msgs);
  const faqCands = C.findRepeatedQuestions(msgs);
  const chunks = C.chunkMessages(kept);

  console.log(`파일: ${path.basename(file)}`);
  console.log(`메시지 ${msgs.length}건 → 노이즈 ${msgs.length - kept.length}건 제외 → 분석 ${kept.length}건`);
  console.log(`미답변 후보 ${cands.length}건, 청크 ${chunks.length}개, 내 이름: ${me}\n`);

  const t0 = Date.now();
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    const transcript = C.renderTranscript(chunks[i]);
    const span = new Set(chunks[i].map((m) => m.i));
    const mine = cands.filter((c) => span.has(c.idx))
      .map((c) => ({ at: C.stamp(c.at), user: c.user, text: c.text }));

    process.stdout.write(`  청크 ${i + 1}/${chunks.length} (${transcript.length}자, 후보 ${mine.length}건) ... `);
    const r = await fetch(`http://localhost:${PORT}/api/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript, me, candidates: mine, faqCandidates: faqCands.filter((f) => f.idx.some((i) => span.has(i))).map((f) => ({ question: f.question, count: f.count, askers: f.askers })) }),
    });
    const j = await r.json();
    if (!r.ok) { console.log(`실패: ${j.error}`); process.exit(1); }
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}초`);
    parts.push(j);
  }

  const merged = C.mergeResults(parts);

  if (chunks.length > 1) {
    process.stdout.write('  reduce ... ');
    const r = await fetch(`http://localhost:${PORT}/api/reduce`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summaries: parts.map((p) => p.summary), faqs: merged.faqs }),
    });
    const j = await r.json();
    if (r.ok) { merged.summary = j.summary; merged.faqs = j.faqs; console.log('완료'); }
    else console.log(`실패: ${j.error}`);
  }

  console.log(`\n총 ${((Date.now() - t0) / 1000).toFixed(1)}초\n`);
  console.log('─── 요약 ───');
  console.log(merged.summary || '(없음)');
  const show = (title, list, fmt) => {
    console.log(`\n─── ${title} (${list.length}) ───`);
    if (!list.length) console.log('(없음)');
    list.forEach((x) => console.log('  • ' + fmt(x)));
  };
  show('답변 안 된 질문', merged.unanswered, (x) => `[${x.at}] ${x.asker}: ${x.question}\n    → ${x.action}`);
  show('공지 후보', merged.notices, (x) => `${x.topic} — ${x.detail}`);
  show('이슈 신호', merged.issues, (x) => `[${x.severity}] ${x.signal} — ${x.detail}` + (x._n > 1 ? ` (${x._n}개 구간 반복)` : ''));
  show('반복 질문', merged.faqs, (x) => `${x.question} (${x.count}회, ${(x.askers||[]).join('/')})` + (x.answer ? `
    답: ${x.answer}` : ' — 대화에 답 없음'));
  console.log(`\n검증에서 버린 항목: ${JSON.stringify(merged.dropped)}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
