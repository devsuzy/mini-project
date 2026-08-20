#!/bin/sh
# 개발 서버 수명주기. 재시작 + 준비 대기를 한 줄로 줄인다.
#
#   ./scripts/dev.sh start          기동 후 /api/config 가 응답할 때까지 대기
#   ./scripts/dev.sh start --fake   가짜 Ollama 도 함께 (모델 없이 UI 를 즉시 채운다)
#   ./scripts/dev.sh restart        stop + start (--fake 그대로 넘길 수 있다)
#   ./scripts/dev.sh stop
#   ./scripts/dev.sh status
#   ./scripts/dev.sh logs [-f]
#
# 왜 있나: 예전에는 매번 kill + npm start + curl 대기 루프 15줄을 다시 타이핑했다.
# 콜당 26초 × 8번이 순수 낭비였다.
set -e
cd "$(dirname "$0")/.."

TMP="${TMPDIR:-/tmp}"
PIDFILE="$TMP/kakao-dev.pid"
LOGFILE="$TMP/kakao-dev.log"
FAKE_PIDFILE="$TMP/kakao-fake-ollama.pid"
FAKE_LOGFILE="$TMP/kakao-fake-ollama.log"

# PORT 결정: 환경변수 > .env > 기본값. 서버가 --env-file-if-exists 로 .env 를 읽으므로
# 여기서도 같은 값을 봐야 준비 확인을 엉뚱한 포트에 하지 않는다.
env_val() { [ -f .env ] && sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env | tail -1 | tr -d '"'"'"'\r'; }
PORT="${PORT:-$(env_val PORT)}"; PORT="${PORT:-5178}"
FAKE_PORT="${FAKE_PORT:-11500}"

alive()   { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
ready()   { curl -fs -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/config" 2>/dev/null; }

# pidfile 의 프로세스가 정말 우리 것일 때만 죽인다.
kill_pidfile() {
  [ -f "$1" ] || return 0
  pid=$(cat "$1")
  if kill -0 "$pid" 2>/dev/null && ps -o command= -p "$pid" 2>/dev/null | grep -q "$2"; then
    kill "$pid" 2>/dev/null || true
    i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$1"
}

listener() { command -v lsof >/dev/null 2>&1 && lsof -ti "tcp:$PORT" 2>/dev/null | head -1; }

# 포트를 물고 있는 우리 서버를 정리한다. pidfile 이 유실돼도(다른 셸·이전 세션) 동작해야 한다.
# 남의 프로그램이 쓰고 있으면 죽이지 않고 실패시킨다.
stop_port() {
  command -v lsof >/dev/null 2>&1 || return 0
  for pid in $(lsof -ti "tcp:$PORT" 2>/dev/null); do
    if ps -o command= -p "$pid" 2>/dev/null | grep -q 'server\.js'; then
      kill "$pid" 2>/dev/null || true
      i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done
      kill -9 "$pid" 2>/dev/null || true
    else
      echo "포트 $PORT 을 다른 프로그램이 쓰고 있습니다 (pid $pid):" >&2
      ps -o command= -p "$pid" >&2
      return 1
    fi
  done
}

# 준비 확인만으로는 부족하다. 새 서버가 EADDRINUSE 로 죽어도 먼저 떠 있던 유령 서버가
# 대신 응답하면 성공으로 보인다 (실제로 그랬다). 서빙 주체가 나인지 확인한다.
confirm_mine() {
  own=$(listener); mine=$(cat "$PIDFILE" 2>/dev/null)
  [ -z "$own" ] && return 0                    # lsof 가 없으면 확인 불가 — 통과
  [ "$own" = "$mine" ] && return 0
  echo "포트 $PORT 을 내가 띄운 프로세스($mine)가 아니라 pid $own 이 물고 있습니다:" >&2
  ps -o command= -p "$own" >&2
  tail -10 "$LOGFILE" >&2
  return 1
}

wait_ready() {
  i=0
  while [ $i -lt 100 ]; do                     # 최대 10초
    ready && return 0
    if ! alive "$PIDFILE"; then
      echo "서버가 죽었습니다. 로그:" >&2; tail -20 "$LOGFILE" >&2; return 1
    fi
    sleep 0.1; i=$((i+1))
  done
  echo "10초 안에 준비되지 않았습니다. 로그:" >&2; tail -20 "$LOGFILE" >&2; return 1
}

start_fake() {
  kill_pidfile "$FAKE_PIDFILE" fake-ollama
  node test/fake-ollama.js "$FAKE_PORT" > "$FAKE_LOGFILE" 2>&1 &
  echo $! > "$FAKE_PIDFILE"
  i=0; while [ $i -lt 50 ]; do
    curl -fs -m 1 -o /dev/null "http://127.0.0.1:$FAKE_PORT/api/tags" && break
    sleep 0.1; i=$((i+1))
  done
  echo "가짜 Ollama  http://127.0.0.1:$FAKE_PORT  (pid $(cat "$FAKE_PIDFILE"))"
}

cmd_start() {
  if alive "$PIDFILE" && ready; then
    echo "이미 떠 있습니다  http://localhost:$PORT  (pid $(cat "$PIDFILE"))"; return 0
  fi
  kill_pidfile "$PIDFILE" server.js
  stop_port || return 1

  if [ "${1:-}" = "--fake" ]; then
    start_fake
    OLLAMA_HOST="http://127.0.0.1:$FAKE_PORT"
    export OLLAMA_HOST
  fi

  # npm 을 거치지 않는다. npm start 로 띄우면 $! 가 npm 의 pid 라서 ps 명령줄에
  # server.js 가 안 잡히고, 그러면 stop 이 자기가 띄운 서버를 못 죽인다 (실제로 그랬다).
  PORT="$PORT" node --env-file-if-exists=.env server.js > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  wait_ready || return 1
  confirm_mine || return 1

  echo "서버        http://localhost:$PORT  (pid $(cat "$PIDFILE"))"
  curl -fs -m 2 "http://127.0.0.1:$PORT/api/config" | sed 's/^/  config    /'
  echo
}

cmd_stop() {
  kill_pidfile "$PIDFILE" server.js
  kill_pidfile "$FAKE_PIDFILE" fake-ollama
  stop_port || true                            # pidfile 이 유실됐을 때를 위한 보조
  echo "정지했습니다 (포트 $PORT)"
}

case "${1:-}" in
  start)   shift; cmd_start "$@" ;;
  stop)    cmd_stop ;;
  restart) cmd_stop >/dev/null; shift; cmd_start "$@" ;;
  status)
    if alive "$PIDFILE" && ready; then
      echo "실행 중  http://localhost:$PORT  (pid $(cat "$PIDFILE"))"
      curl -fs -m 2 "http://127.0.0.1:$PORT/api/config" | sed 's/^/  config  /'; echo
      alive "$FAKE_PIDFILE" && echo "가짜 Ollama 실행 중  http://127.0.0.1:$FAKE_PORT"
    else
      echo "정지 상태 (포트 $PORT)"; exit 1
    fi ;;
  logs)    shift; [ "${1:-}" = "-f" ] && tail -f "$LOGFILE" || tail -40 "$LOGFILE" ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 1 ;;
esac
