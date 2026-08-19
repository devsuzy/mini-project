'use strict';
// 파서·필터·질문탐지 단위 검증. 빌드 단계가 없으므로 node 로 직접 돌린다.
//   ./test/run.sh
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const core = execFileSync(path.join(__dirname, 'extract-core.sh'), { encoding: 'utf8' });
const C = {};
new Function('module', core + '\nmodule.exports=module.exports;')({ get exports() { return C; }, set exports(v) { Object.assign(C, v); } });

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? `\n      → ${extra}` : ''}`); }
};
const eq = (a, b, name) => ok(a === b, name, `기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`);

const raw = fs.readFileSync(path.join(root, 'sample-chat.csv'), 'utf8');

console.log('\n코어 블록 추출');
ok(!core.includes('</scr'+'ipt>'), '추출물에 </scr'+'ipt> 가 섞이지 않았다 (sed 범위가 UI 블록까지 삼키면 여기서 잡힌다)');
ok(!/document\.|window\./.test(core), '코어에 DOM 참조가 없다 — 순수 로직만 있어야 한다');
ok(core.length > 3000 && core.length < 20000, `추출 크기가 상식적이다 (${core.length}자)`);

console.log('\nCSV 파서');
ok(raw.charCodeAt(0) === 0xfeff, '픽스처에 BOM 이 실제로 들어있다 (없으면 이 테스트가 무의미)');
const rows = C.parseCsv(raw);
eq(rows[0][0], 'Date', 'BOM 을 벗겨서 첫 헤더가 "Date" 로 잡힌다');
eq(rows[0].length, 3, '헤더가 3열이다');
ok(rows.every((r) => r.length === 3), '모든 행이 3열이다 — 멀티라인이 행을 쪼개지 않았다');
eq(rows.length, 35, '헤더1 + 레코드34 = 35행 (물리적 줄 수 46 과 달라야 정상)');

const ml = rows.find((r) => r[2].includes('장비 도입 방안'));
ok(!!ml, '멀티라인 레코드를 찾았다');
ok(ml && ml[2].split('\n').length === 12, '멀티라인 메시지가 개행을 보존한 채 레코드 1개로 들어왔다', ml && `줄 수 ${ml[2].split('\n').length}`);
ok(ml && ml[2].includes('https://example.com/store/sensor-b'), '멀티라인 본문 마지막 URL 까지 온전하다');

console.log('\n메시지 변환');
const msgs = C.toMessages(rows);
eq(msgs.length, 34, '레코드 34건이 모두 메시지가 됐다');
const deleted = msgs.filter((m) => m.noise === '삭제된 메시지');
eq(deleted.length, 2, 'Date 가 빈 삭제 행 2건이 버려지지 않았다');
ok(deleted.every((m) => m.at instanceof Date), '삭제 행이 직전 메시지의 시각을 승계했다');
eq(C.ymd(deleted[0].at), '2026-08-06', '첫 삭제 행이 직전 행(08-06)의 날짜를 물려받았다');

console.log('\n노이즈 필터');
const kept = msgs.filter((m) => !m.noise);
const dropped = msgs.filter((m) => m.noise);
eq(kept.length + dropped.length, msgs.length, '분류가 전수를 덮는다');
eq(C.noiseReason('사진'), '미디어', '"사진"');
eq(C.noiseReason('사진 3장'), '미디어', '"사진 3장"');
eq(C.noiseReason('파일: 장비_비교표.xlsx'), '파일 첨부', '"파일: ..."');
eq(C.noiseReason('(놀람)(하트)'), '이모티콘', '이모티콘만 있는 메시지');
eq(C.noiseReason('ㅋㅋㅋㅋ'), '리액션', '"ㅋㅋㅋㅋ"');
eq(C.noiseReason('ㅠㅠ'), '리액션', '"ㅠㅠ"');
eq(C.noiseReason('부스 시안 나왔어요!'), null, '실제 대화는 남긴다');
eq(C.noiseReason('넵 확인했습니다'), null, '짧아도 뜻이 있으면 남긴다');
ok(msgs.find((m) => m.file === '장비_비교표.xlsx'), '파일명은 따로 보관한다');

console.log('\n질문 탐지');
ok(C.isQuestion('다음 주 워크샵 장소 확정됐을까요?'), '물음표로 끝나는 질문');
ok(C.isQuestion('프로세스 는 연구 하고  있나요'), '물음표 없는 질문 ("있나요")');
ok(!C.isQuestion('드라이브 공유폴더 > 계약 안에 있어요'), '평서문은 질문이 아니다');
ok(!C.isQuestion('정리 고마워요'), '인사는 질문이 아니다');

console.log('\n미답변 판정 (핵심)');
const cands = C.findUnansweredCandidates(msgs);
const has = (frag) => cands.find((c) => c.text.includes(frag));
ok(has('워크샵 장소'), '[미답변] 08-07 워크샵 장소 — 이모티콘만 달렸다');
ok(has('설치 일정'), '[미답변] 08-14 설치 일정 — 본인 이모티콘뿐이다');
ok(has('보안 점검'), '[불확실] 08-19 보안 점검 — 사진으로만 응답했다');
ok(has('보안 점검') && has('보안 점검').uncertain, '  └ 미디어 응답이라 uncertain 으로 표시됐다');
ok(!has('외주 계약서 양식 어디에'), '[대조군] 08-06 계약서 질문은 텍스트 답변이 있어 제외됐다');
ok(!has('다시 알려주실 수'), '[대조군] 08-18 계약서 재질문도 답변이 있어 제외됐다');
eq(cands.length, 3, '후보가 정확히 3건이다 (오탐 없음)');

console.log('\n청킹');
const chunks = C.chunkMessages(kept);
eq(chunks.length, 1, '작은 샘플은 청크 1개');
ok(chunks[0].length === kept.length, '메시지 유실이 없다');

const big = [];
const base = new Date(2026, 0, 1, 9, 0, 0);
for (let d = 0; d < 40; d++) for (let k = 0; k < 30; k++) {
  const at = new Date(base); at.setDate(base.getDate() + d); at.setMinutes(k * 3);
  big.push({ i: big.length, at, user: `사람${k % 4}`, text: '가'.repeat(60), noise: null, file: null });
}
const bigChunks = C.chunkMessages(big);
ok(bigChunks.length > 1, `큰 입력이 여러 청크로 쪼개진다 (${bigChunks.length}개)`);
ok(bigChunks.every((c) => c.reduce((n, m) => n + m.text.length + 20, 0) <= C.CHUNK_CHARS * 1.05),
   '모든 청크가 예산 안에 있다', bigChunks.map((c) => c.reduce((n, m) => n + m.text.length + 20, 0)).join(','));
const covered = new Set(bigChunks.flat().map((m) => m.i));
eq(covered.size, big.length, '청킹이 메시지를 하나도 빠뜨리지 않았다');

console.log('\n실제 카톡 파일 (있으면)');
const realPath = path.join(process.env.HOME, 'Downloads', 'KakaoTalk_Chat_그룹채팅_2026-08-19-16-34-54.csv');
if (fs.existsSync(realPath)) {
  const rm = C.toMessages(C.parseCsv(fs.readFileSync(realPath, 'utf8')));
  ok(rm.length > 0, `실제 파일에서 메시지 ${rm.length}건 파싱`);
  const rc = C.findUnansweredCandidates(rm);
  ok(rc.some((c) => c.text.includes('엑셀시트')), '합격선: 11:03 "엑셀시트 구할 수 있을까요?" 가 미답변으로 잡힌다',
     `잡힌 후보: ${rc.map((c) => c.text.slice(0, 24)).join(' / ') || '없음'}`);
  ok(!rc.some((c) => c.text.includes('프로세스')), '대조군: "프로세스는 연구하고 있나요" 는 답변이 있어 제외');
} else {
  console.log('  - 건너뜀 (파일 없음)');
}


console.log('\n반복 질문 탐지 (FAQ 후보)');
{
  const rows2 = C.parseCsv(fs.readFileSync(path.join(root, 'sample-chat.csv'), 'utf8'));
  const m2 = C.toMessages(rows2);
  const faqs = C.findRepeatedQuestions(m2);
  eq(faqs.length, 1, '반복 질문 묶음이 1건이다');
  ok(faqs[0] && faqs[0].count === 3, '계약서 양식 질문 3건이 한 묶음으로 뭉쳤다', faqs[0] && `count=${faqs[0].count}`);
  ok(faqs[0] && faqs[0].askers.length === 3, '서로 다른 3명이 물었다', faqs[0] && faqs[0].askers.join(','));
  ok(faqs[0] && faqs[0].question.includes('계약서'), '묶음 대표 질문이 계약서 건이다');

  // 어미만 같고 내용이 다른 질문은 묶이면 안 된다 (어미 제거가 없으면 오탐 나는 자리)
  ok(C.similarity('회식 장소 알려주실 수 있나요?', '서버 접속 정보 알려주실 수 있나요?') < C.FAQ_THRESHOLD,
     '공통 어미만 같은 질문은 묶이지 않는다',
     `유사도 ${C.similarity('회식 장소 알려주실 수 있나요?', '서버 접속 정보 알려주실 수 있나요?').toFixed(3)}`);
  ok(C.similarity('혹시 외주 계약서 양식 어디에 있나요?', '혹시 외주 계약서 양식 어디 있나요?') > 0.8,
     '거의 같은 질문은 높은 유사도');
  eq(C.normQuestion('회식 장소 알려주실 수 있나요?'), '회식장소', '어미와 군말이 제거된다');

  const solo = C.findRepeatedQuestions([
    { i:0, at:new Date(2026,0,1,9,0), user:'A', text:'서버 주소 알려주실 수 있나요?', noise:null },
    { i:1, at:new Date(2026,0,1,10,0), user:'A', text:'서버 주소 알려주실 수 있나요?', noise:null },
  ]);
  eq(solo.length, 0, '같은 사람이 두 번 물은 건 FAQ 가 아니다 (미답변 쪽 일이다)');
}

console.log("\n청크 결과 병합");
{
  // 실제로 큰 파일에서 나온 모양: 청크 4개가 같은 이슈를 각자 보고한다
  const parts = [
    { summary: "1구간", unanswered: [{ at: "2026-07-01 23:50", question: "1일차 잔여 이슈는?", asker: "A", action: "확인" }],
      notices: [], issues: [{ signal: "스테이징에서 재현이 안 되네요", detail: "d1", severity: "mid", at: "x" }],
      faqs: [{ question: "잔여 이슈는 누가?", count: 3, askers: ["A"], answer: "" }], dropped: { issues: 1 } },
    { summary: "2구간", unanswered: [{ at: "2026-07-01 23:50", question: "1일차 잔여 이슈는?", asker: "A", action: "확인" }],
      notices: [], issues: [{ signal: "스테이징에서 재현이 안 되네요", detail: "d2", severity: "high", at: "y" }],
      faqs: [{ question: "잔여 이슈는 누가?", count: 5, askers: [], answer: "담당자 미정" }], dropped: { issues: 2 } },
    { summary: "3구간", unanswered: [{ at: "2026-07-05 10:00", question: "다른 질문?", asker: "B", action: "확인" }],
      notices: [], issues: [{ signal: "지표가 조금 떨어졌네요", detail: "d3", severity: "low", at: "z" }],
      faqs: [], dropped: {} },
  ];
  const m = C.mergeResults(parts);
  eq(m.unanswered.length, 2, "같은 시각·같은 질문은 한 건으로 접힌다");
  eq(m.issues.length, 2, "같은 이슈가 여러 청크에서 나와도 한 건으로 접힌다");
  eq(m.issues[0].severity, "high", "겹친 이슈는 가장 높은 심각도를 남긴다");
  eq(m.issues[0]._n, 2, "몇 개 구간에서 반복됐는지 센다");
  eq(m.faqs.length, 1, "같은 FAQ 가 하나로 묶인다");
  eq(m.faqs[0].answer, "담당자 미정", "빈 답 대신 채워진 답을 살린다");
  eq(m.faqs[0].count, 5, "더 큰 count 를 남긴다");
  eq(m.dropped.issues, 3, "버려진 항목 수는 합산한다");
  ok(m.summary.includes("1구간") && m.summary.includes("3구간"), "요약은 모두 이어붙인다 (reduce 가 뒤에서 다시 쓴다)");

  // 서로 다른 이슈는 합쳐지면 안 된다
  const diff = C.mergeResults([{ summary: "", unanswered: [], notices: [], faqs: [], dropped: {},
    issues: [{ signal: "광고 게시물이 올라왔습니다", detail: "", severity: "high", at: "" },
             { signal: "회의가 너무 잦습니다", detail: "", severity: "mid", at: "" }] }]);
  eq(diff.issues.length, 2, "내용이 다른 이슈는 따로 남는다");
}

console.log("\n예상 소요 시간");
ok(C.estimateSeconds(1) >= 60, "1청크 추정이 실측(45~180초)보다 낙관적이지 않다", String(C.estimateSeconds(1)));
ok(C.estimateSeconds(4) >= 300, "4청크 추정이 실측 383초에 근접한다", String(C.estimateSeconds(4)));


console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
