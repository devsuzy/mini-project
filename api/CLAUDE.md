# api/CLAUDE.md

`server.js` (프로젝트 루트) 의 HTTP 라우트·Ollama 프록시·프롬프트·스키마에 대한 지침.
브라우저 쪽(CSV 파싱·필터·탐지·청킹·병합)은 루트 `CLAUDE.md` 를 볼 것.

> **코드 위치**: API 구현은 `api/` 가 아니라 루트 `server.js` 한 파일에 있다.
> `npm start`(`node --env-file-if-exists=.env server.js`) 와 `test/e2e.js` 가 이 경로를 참조하므로
> 옮기려면 `package.json` 과 테스트를 함께 고쳐야 한다. 이 디렉터리는 문서 전용이다.

## 라우트

| 라우트 | 요청 | 응답 | 비고 |
|---|---|---|---|
| `GET /` `GET /index.html` | — | `index.html` | 요청마다 디스크에서 읽는다 → **HTML 수정은 서버 재시작 불필요** |
| `GET /api/config` | — | `{model, running, hasModel, maxInputChars}` | UI 가 준비 안내 배너를 띄울지 결정 |
| `POST /api/analyze` | `{transcript, me, candidates, faqCandidates}` | `{summary, unanswered, notices, issues, faqs, dropped}` | 청크 1개 |
| `POST /api/reduce` | `{summaries, faqs}` | `{summary, faqs}` | 청크가 2개 이상일 때 요약·FAQ 를 한 번 더 합침 |
| 그 외 | — | `404 Not Found` | 정적 파일 서빙은 `index.html` 뿐이다 |

에러는 전부 `{error: "<한국어 문장>"}` 이다. 400 은 입력 문제(빈 대화, 길이 초과, 합칠 요약 없음),
500 은 Ollama 쪽 문제다. `callOllama()` 가 사용자에게 그대로 보여줄 수 있는 문장으로 바꿔서 던진다
(연결 실패 → `ollama serve` 안내, 404 → `ollama pull <model>` 안내, 타임아웃 → 기간 축소 안내).

## 상수와 환경 변수

| 이름 | 기본값 | 메모 |
|---|---|---|
| `PORT` | `5178` | 환경 변수 |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | 환경 변수 |
| `OLLAMA_MODEL` | `qwen2.5:7b` | 환경 변수 |
| `NUM_CTX` | `16384` | Ollama 기본값 2048 을 덮어쓴다 |
| `MAX_INPUT_CHARS` | `6000` | `transcript` 가 이 값의 1.2배를 넘으면 400 |
| `MAX_BODY_BYTES` | `1_000_000` | 넘으면 소켓을 끊는다 |
| `REQUEST_TIMEOUT_MS` | `180_000` | 첫 요청은 모델을 메모리에 올리느라 수십 초 걸린다 |

`readBody()` 는 `req.setEncoding('utf8')` 을 먼저 부른다. **없으면 UTF-8 한글이 chunk 경계에서 깨진다.**

`checkOllama()` 의 모델 매칭은 **정확 매칭이다.** 접두어로 보면 `qwen2.5:3b` 만 설치돼 있어도
`qwen2.5:7b` 가 있다고 착각한다. 태그가 없으면 `:latest` 를 붙여서 비교한다.

## 프롬프트와 스키마는 한 몸이다

`AI-new-project` 에서 넘어온 교훈에 이 프로젝트에서 새로 얻은 것을 더했다.

- **Ollama 는 JSON 스키마의 `description` 을 모델에게 전달하지 않는다.** 스키마는 GBNF 로 컴파일돼 *출력 형태*만 강제한다. 필드 의미는 반드시 `systemPrompt()` 에 있어야 한다. (호스팅 API 는 정반대다 — 다른 프로바이더에서 코드를 옮길 때 조용히 깨지는 지점.)
- **`properties` 의 순서가 곧 생성 순서다.** `summary` 를 맨 앞에 뒀더니 모델이 요약을 쓰고 나서 "할 말 다 했다" 는 듯 뒤쪽 배열을 비워 보냈다 — `issues` 와 `faqs` 가 통째로 빈 채 나왔다. **배열 넷을 먼저 채우게 하고 `summary` 를 맨 뒤로 옮겨서 고쳤다.** 순서를 되돌리기 전에 이 문장을 볼 것.
- **예시는 자리표시자(`<사람 이름>`)로 쓰고 "그대로 출력하지 말라"고 명시한다.** 현실적인 예시를 넣으면 모델이 대화 대신 예시를 베껴서 없는 항목을 만들어낸다. `tidy()` 의 `PLACEHOLDER` 정규식이 그래도 새어 나온 `<...>` 를 걷어낸다.
- **`num_ctx: 16384` 를 명시한다.** Ollama 기본값은 2048 이고, 넘치면 **에러 없이 잘라낸다.**
- **`temperature: 0`** — 추출 작업이라 같은 입력에 같은 결과가 나와야 한다.
- **제외 기준을 적는 것이 포함 기준보다 중요하다.** `issues` 에 "힘들다/바쁘다" 를 넣으라고만 썼더니 실제 파일에서 `"이번주는 넘 바빠서 다음주부터 조사하려고요"`(단순 일정 조율)와 `"백화점 야간에 작업했어요"`(근황 공유)를 피로 호소로 잡아 오탐 3건이 나왔다. **"넣지 않는 것" 목록을 명시하자 오탐이 0이 되고, 덤으로 비어 있던 `notices` 까지 살아났다.**
- **날짜는 계산시키지 말고 찾게 한다.** `dateReference()` 가 이번 주 월요일부터 21일치 `YYYY-MM-DD = 이번 주 O요일` 표를 프롬프트에 깔아 준다. 7B 는 날짜 산술을 자주 틀리지만 표에서 찾기는 잘한다.

필드를 추가할 때는 네 곳을 함께 고쳐야 한다:
1. `ANALYZE_SCHEMA` (`server.js`) — 형태와 **순서**
2. `systemPrompt()` (`server.js`) — 의미
3. `tidy()` (`server.js`) — 검증
4. `render()` / `copyMd` (`index.html`) — 표시

## `tidy()` 가 모델을 후보 목록 안에 가둔다

규칙이 후보를 확정하고 모델은 판정·문장 다듬기만 한다(루트 `CLAUDE.md` 의 "규칙 + LLM 하이브리드").
GBNF 는 형태만 강제하고 의미는 강제하지 않으므로 `tidy()` 가 마지막 관문이다.

- `unanswered` — 브라우저가 보낸 `candidates` 에 없는 질문은 버린다(부분 문자열 포함은 허용).
- `faqs` — `faqCandidates` 안에서만 인정하고, **`count` 는 모델 말 대신 규칙이 센 값으로 덮어쓴다.**
- `issues.severity` — `high`/`mid`/`low` 가 아니면 `low` 로 떨어뜨린다.
- 빈 문자열·자리표시자만 남는 항목은 버리고, 버린 개수를 `dropped` 로 돌려준다. **UI 가 이걸 보여주므로 조용히 버리지 말 것.**

`/api/reduce` 는 `tidy()` 를 쓰지 않고 인라인으로 거른다 — `count < 2` 인 FAQ 는 버린다.

## 서버가 지켜야 하는 프라이버시 규칙

- `server.listen(PORT, '127.0.0.1')` — 기본값(`0.0.0.0`)이면 같은 Wi-Fi 의 다른 기기에서 남의 카톡 대화가 열린다. UI 의 "밖으로 나가지 않습니다" 문구와 정면으로 어긋나므로 되돌리지 말 것.
- 외부로 나가는 요청은 `OLLAMA_HOST` 하나뿐이다. 텔레메트리·에러 리포팅·CDN 을 추가하지 말 것.
- 대화 원문을 디스크에 쓰지 않는다. 로그는 `console.error('[analyze]', err.message)` 처럼 **메시지만** 남기고 본문은 남기지 않는다.

## 검증

```bash
npm test                               # 전체 단위 스위트 (모델 불필요, 0.7초)
node test/server.test.js               # 서버 계약만 (프롬프트·스키마·tidy)
node --check server.js                 # 문법 검사 (빌드 단계 없음)
node test/e2e.js                       # 허구 샘플로 실제 모델까지 태우기 (~45초)

npm run dev:fake                       # 가짜 Ollama 를 붙여 기동 — 모델 없이 UI 확인
node test/fake-ollama.js 11500         # 가짜 Ollama 만 따로 띄우기

# Ollama 다운 상태 재현 — 죽은 포트를 가리켜 별도 인스턴스 기동
PORT=5188 OLLAMA_HOST=http://127.0.0.1:19999 npm start
```

**`test/server.test.js` 가 이 문서의 규칙을 실제로 붙잡고 있다.** `test/fake-ollama.js`
(스텁 Ollama)를 `OLLAMA_HOST` 로 끼워서 모델 없이 돌린다. 지금 걸려 있는 것:

| 이 문서의 규칙 | 테스트가 잡는 방식 |
|---|---|
| `properties` 순서 = 생성 순서, `summary` 는 맨 뒤 | 나간 `format.properties` 키 순서를 직접 비교 |
| `num_ctx: 16384` 명시 (기본 2048 은 조용히 자름) | 나간 `options.num_ctx` 확인 |
| `temperature: 0` | 나간 `options.temperature` 확인 |
| 날짜는 계산 말고 표에서 찾게 | 시스템 프롬프트에 날짜 대조표가 있는지 |
| `tidy()` 가 후보 밖 질문을 버린다 | 없는 질문을 **골라서 먹이고** `dropped` 확인 |
| `faqs.count` 는 규칙 값으로 덮어쓴다 | 모델이 `count: 99` 를 줘도 규칙의 `3` 이 남는지 |
| `severity` 는 high/mid/low 로 제한 | `"critical"` 을 먹여 `low` 로 떨어지는지 |
| 자리표시자(`<...>`)를 걷어낸다 | `<주제>` 를 먹여 버려지는지 |
| 장애를 사용자 문장으로 바꾼다 | 404·깨진 JSON·빈 응답을 먹여 안내 문구 확인 |
| `readBody()` 의 `setEncoding` | 한글 한 글자 **한복판에서 쪼개** 보내고 왕복 비교 |
| `checkOllama()` 의 정확 매칭 | 태그를 `qwen2.5:3b` 만 두고 `hasModel: false` 확인 |
| 상한 초과는 400 | 모델이 **아예 호출되지 않았는지**까지 확인 |

이 표의 항목을 고칠 때는 `test/server.test.js` 도 같이 고쳐야 한다. 반대로,
**여기 없는 것 — 답변 판정의 질, 요약 문장, 필드 배분 — 은 여전히 모델이 필요하다.**
프롬프트 문구를 손봤으면 `node test/e2e.js` 로 허구 샘플과 실제 파일 둘 다 눈으로 확인해야 한다.
합격선 케이스는 루트 `CLAUDE.md` 의 "검증" 절에 있다.

## 알려진 한계 (서버 쪽, 미해결)

| 위치 | 문제 |
|---|---|
| 프롬프트 전반 | 7B 모델이라 **같은 정보가 실행마다 다른 필드에 담긴다.** 계약서 위치가 어떤 실행에서는 `faqs.answer` 로, 어떤 실행에서는 `notices` 로 갔다. `temperature:0` 이어도 프롬프트가 바뀌면 흔들린다. 필드 간 이동은 정보 손실이 아니지만 회귀 테스트를 어렵게 만든다 |
| `systemPrompt()` | **action 의 주어가 방장이 아닌 질문자로 새는 일이 있다.** 12건 중 3건에서 `"박서연에게 ~해달라고 요청하기"` 처럼 나왔다. 프롬프트에 "질문한 사람을 주어로 쓰면 틀린 것" 이라고 못박아도 7B 는 완전히 지키지 못한다 |
| 청크 경계 | 모델은 청크 안만 보므로 `action` 문장이 맥락을 놓칠 수 있다. (미답변 후보 판정 자체는 브라우저가 전체 타임라인으로 하므로 옳게 나온다) |
| 취소 | `/api/analyze` 는 중단 경로가 없다. 브라우저가 떠나도 `REQUEST_TIMEOUT_MS` 까지 모델이 돈다 |
