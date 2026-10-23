#!/usr/bin/env bash
# Stop the isolated test stack started by tests/start-stack.sh.
set -uo pipefail
TMP="${AAP_TEST_DIR:-/tmp/aap-test}"
for name in orchestrator mock; do
  pidfile="$TMP/$name.pid"
  [ -f "$pidfile" ] || continue
  pid=$(cat "$pidfile" 2>/dev/null || true)
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
done
if command -v tmux >/dev/null 2>&1; then
  TMUX_TMPDIR="$TMP/tmux" tmux kill-server >/dev/null 2>&1 || true
fi
echo "isolated stack stopped"
