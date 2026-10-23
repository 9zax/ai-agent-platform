#!/usr/bin/env bash
# Isolated test stack: a deterministic mock LLM + a second orchestrator with
# its own DATA_DIR/workspace, running headless (PATH hides tmux) so it can
# never touch the real agents or the user's data. Ports: API 8010, mock 9101.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="${AAP_TEST_DIR:-/tmp/aap-test}"
API_PORT="${AAP_TEST_API_PORT:-8010}"
MOCK_PORT="${AAP_TEST_MOCK_PORT:-9101}"
ADMIN_USER="admin"
ADMIN_PASSWORD="testpass"
BIN="$ROOT/orchestrator/target/release/orchestrator"

"$ROOT/tests/stop-stack.sh" >/dev/null 2>&1 || true
if command -v tmux >/dev/null 2>&1; then
  TMUX_TMPDIR="$TMP/tmux" tmux kill-server >/dev/null 2>&1 || true
fi
rm -rf "$TMP"
mkdir -p "$TMP/data" "$TMP/workspace" "$TMP/logs"

if [ ! -x "$BIN" ]; then
  echo "building orchestrator…"
  (cd "$ROOT/orchestrator" && cargo build --release)
fi

# 1. mock provider ---------------------------------------------------------
MOCK_PORT="$MOCK_PORT" node "$ROOT/tests/mock-llm.js" >"$TMP/logs/mock.log" 2>&1 &
echo $! >"$TMP/mock.pid"

# 2. a local bare repo so the PR stage has a real origin + diff to review --
git init --bare -q "$TMP/origin"
git -C "$TMP/origin" symbolic-ref HEAD refs/heads/main
SEED="$TMP/seed"
git clone -q "$TMP/origin" "$SEED"
git -C "$SEED" config user.email "e2e@example.test"
git -C "$SEED" config user.name "E2E Harness"
printf '# e2e fixture repo\n' >"$SEED/README.md"
git -C "$SEED" add README.md
git -C "$SEED" commit -q -m "initial"
git -C "$SEED" branch -M main
git -C "$SEED" push -q origin main
rm -rf "$SEED"

# 3. isolated orchestrator. tmux is exposed through a private socket dir
#    (TMUX_TMPDIR) so its agent-* sessions can never collide with the real
#    stack; gh stays off the PATH so the PR stage reports the honest skip.
mkdir -p "$TMP/bin" "$TMP/tmux"
ln -sf "$(command -v tmux)" "$TMP/bin/tmux"
env -i \
  PATH="$TMP/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="${HOME:-/tmp}" \
  TMUX_TMPDIR="$TMP/tmux" \
  DATA_DIR="$TMP/data" \
  AAP_WORKSPACE="$TMP/workspace" \
  AAP_BIND="127.0.0.1:$API_PORT" \
  ADMIN_USER="$ADMIN_USER" \
  ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  AI_API_KEY="test-key" \
  AI_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1" \
  "$BIN" >"$TMP/logs/orchestrator.log" 2>&1 &
echo $! >"$TMP/orchestrator.pid"

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null || {
  echo "orchestrator failed to start:" >&2
  tail -30 "$TMP/logs/orchestrator.log" >&2
  exit 1
}

# 4. point the isolated instance at the mock provider ----------------------
TOKEN=$(curl -fsS -X POST "http://127.0.0.1:$API_PORT/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')
curl -fsS -X PUT "http://127.0.0.1:$API_PORT/config" \
  -H 'Content-Type: application/json' -H "x-session-token: $TOKEN" \
  -d "{\"ai_provider\":\"openai\",\"ai_base_url\":\"http://127.0.0.1:$MOCK_PORT/v1\",\"ai_api_key\":\"test-key\",\"auto_pause_enabled\":false}" \
  >/dev/null

cat >"$TMP/env.sh" <<EOF
export API_URL=http://127.0.0.1:$API_PORT
export MOCK_URL=http://127.0.0.1:$MOCK_PORT
export REPO_URL=file://$TMP/origin
export AAP_TEST_DIR=$TMP
export ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF

echo "isolated stack up — API http://127.0.0.1:$API_PORT · mock http://127.0.0.1:$MOCK_PORT"
