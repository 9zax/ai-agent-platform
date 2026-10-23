# AI Agent Platform — host execution edition
#
# Agents run as tmux sessions on THIS machine (see `tmux attach -t agent-<role>`),
# the orchestrator and web run as plain host processes. The platform does not
# use Docker at all — the only target that touches docker is `migrate-state`,
# a one-time tool that pulls state out of the pre-migration docker volumes.
#
# Common targets:
#   make build          cargo release build + web production build
#   make run            start orchestrator (:8000) + web (:3000) in the foreground
#   make api / make web start just one of them
#   make test           run the Playwright e2e suite against :3000
#   make migrate-state  one-time: copy runs.json/paused.json + workspace out of
#                       the old docker volumes into ./data and ./workspace

SHELL := /bin/bash
ROOT  := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
DATA  := $(ROOT)/data
WS    := $(ROOT)/workspace

# Source .env (if present) so AI_API_KEY / ADMIN_USER / ADMIN_PASSWORD etc.
# reach the launched process — must run in the SAME shell line as the launch
# (each make recipe line is its own shell). Values already set in the
# environment win (sourcing does not override existing vars with `set -a`
# only when the var is assigned with ${VAR:-} defaults — so keep .env simple).
ENV_SOURCE := [ -f "$(ROOT)/.env" ] && set -a && . "$(ROOT)/.env" && set +a || true

.PHONY: build api web run test build-web migrate-state clean

build:
	cd $(ROOT)/orchestrator && cargo build --release
	cd $(ROOT)/web && npm ci && npm run build

api:
	@mkdir -p $(DATA) $(WS)
	cd $(ROOT)/orchestrator && \
	$(ENV_SOURCE); \
	DATA_DIR=$(DATA) AAP_WORKSPACE=$(WS) \
	exec ./target/release/orchestrator

web:
	$(ENV_SOURCE) && cd $(ROOT)/web && exec npm start

# Both processes in the foreground; Ctrl-C (or the death of either) stops both.
run:
	@mkdir -p $(DATA) $(WS)
	$(ENV_SOURCE); \
	trap 'kill 0' EXIT; \
	DATA_DIR=$(DATA) AAP_WORKSPACE=$(WS) $(ROOT)/orchestrator/target/release/orchestrator & \
	cd $(ROOT)/web && npm start & \
	wait

# e2e needs the credentials from .env (ADMIN_PASSWORD) — sourced here first.
test: build-web
	$(ENV_SOURCE); \
	cd $(ROOT)/web/e2e && npx playwright test

build-web:
	cd $(ROOT)/web && npm run build

# One-time migration from the old dockerized stack: copy the persisted state
# and the shared workspace out of the docker volumes. Skips gracefully when
# the volumes no longer exist.
migrate-state:
	@mkdir -p $(DATA) $(WS)
	@if docker volume inspect ai-agent-platform_agent-data >/dev/null 2>&1; then \
	  echo "→ copying runs.json/paused.json from volume ai-agent-platform_agent-data"; \
	  docker run --rm -v ai-agent-platform_agent-data:/from -v $(DATA):/to alpine \
	    sh -c 'cp -a /from/. /to/ 2>/dev/null; rm -f /to/platform.db'; \
	else echo "• volume ai-agent-platform_agent-data not found — skipping state copy"; fi
	@if docker volume inspect ai-agent-platform-workspace >/dev/null 2>&1; then \
	  echo "→ copying the shared workspace from volume ai-agent-platform-workspace"; \
	  docker run --rm -v ai-agent-platform-workspace:/from -v $(WS):/to alpine \
	    sh -c 'cp -a /from/. /to/'; \
	else echo "• volume ai-agent-platform-workspace not found — skipping workspace copy"; fi
	@echo "✓ migration done — history in $(DATA), working tree in $(WS)"

clean:
	cd $(ROOT)/orchestrator && cargo clean
	rm -rf $(ROOT)/web/.next $(ROOT)/web/node_modules
