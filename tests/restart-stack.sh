#!/usr/bin/env bash
# Restart ONLY the isolated orchestrator, keeping DATA_DIR, workspace, the mock
# provider and the bare origin repo. Used by persistence tests to prove that
# projects/docs/tasks/runs survive a real process restart.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="${AAP_TEST_DIR:-/tmp/aap-test}"
API_PORT="${AAP_TEST_API_PORT:-8010}"
MOCK_PORT="${AAP_TEST_MOCK_PORT:-9101}"
BIN="$ROOT/orchestrator/target/release/orchestrator"

[ -d "$TMP/data" ] || { echo "no isolated stack at $TMP — run tests/start-stack.sh first" >&2; exit 1; }

pidfile="$TMP/orchestrator.pid"
if [ -f "$pidfile" ]; then
  pid=$(cat "$pidfile" 2>/dev/null || true)
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
  fi
fi

mkdir -p "$TMP/bin" "$TMP/tmux" "$TMP/logs"
ln -sf "$(command -v tmux)" "$TMP/bin/tmux"
env -i \
  PATH="$TMP/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="${HOME:-/tmp}" \
  TMUX_TMPDIR="$TMP/tmux" \
  DATA_DIR="$TMP/data" \
  AAP_WORKSPACE="$TMP/workspace" \
  AAP_BIND="127.0.0.1:$API_PORT" \
  ADMIN_USER="admin" \
  ADMIN_PASSWORD="testpass" \
  AI_API_KEY="test-key" \
  AI_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1" \
  "$BIN" >>"$TMP/logs/orchestrator.log" 2>&1 &
echo $! >"$pidfile"

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
    echo "isolated orchestrator restarted on $API_PORT (data preserved at $TMP/data)"
    exit 0
  fi
  sleep 0.1
done

tail -30 "$TMP/logs/orchestrator.log" >&2
echo "orchestrator failed to restart" >&2
exit 1
