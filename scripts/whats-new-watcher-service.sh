#!/bin/bash
# scripts/whats-new-watcher-service.sh
# Wrapper that launchd runs to keep the What's New draft watcher alive (scripts/whats-new-draft-watcher.mjs).
# launchd starts processes with a minimal environment, so set an explicit PATH for node / npx / claude.
# The watcher reads PRODUCT_UPDATES_INGEST_TOKEN from .env itself.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

export PATH="/opt/homebrew/bin:/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

echo "▶ starting What's New draft watcher ($(date))"
exec node scripts/whats-new-draft-watcher.mjs
