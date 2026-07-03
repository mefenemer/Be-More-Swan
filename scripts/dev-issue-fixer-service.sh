#!/bin/bash
# scripts/dev-issue-fixer-service.sh
# Wrapper that launchd runs to keep the AI auto-fix watcher alive.
# launchd starts processes with a minimal environment, so we set an explicit PATH
# (for claude / gh / git / node) and load config from .env.handoff ourselves.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# claude (npm global), gh + node (homebrew), git (system).
export PATH="/opt/homebrew/bin:/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [ ! -f "$REPO/.env.handoff" ]; then
  echo "✖ $REPO/.env.handoff not found — copy scripts/dev-issue-fixer.env.example and fill it in." >&2
  exit 1
fi

# Load config (KEY=VALUE lines) into the environment.
set -a
# shellcheck disable=SC1091
source "$REPO/.env.handoff"
set +a

if [ -z "${DEV_HANDOFF_TOKEN:-}" ]; then
  echo "✖ DEV_HANDOFF_TOKEN is empty in .env.handoff — the watcher cannot authenticate. Idling." >&2
  # Exit non-zero so KeepAlive backs off and retries rather than hot-looping.
  sleep 30
  exit 1
fi

echo "▶ starting dev-issue-fixer watcher ($(date))"
# Tells the watcher it's supervised: on a portal-requested restart it just exits and
# launchd's KeepAlive relaunches it (instead of re-spawning itself).
export AURA_RUNNER_SUPERVISED=1
exec node scripts/dev-issue-fixer.mjs
