#!/bin/bash
# SessionStart hook — installs node_modules so tsc, next lint, and the
# build can resolve react / next / supabase types in remote Claude Code
# sessions. Without this, every JSX file errors with TS7026 (no
# JSX.IntrinsicElements) and tsc returns 74k+ false positives.
#
# Synchronous: the session waits for `npm install` to finish (~30-60s on
# a cold cache). Flip to async by emitting {"async": true} on stdout
# before the install if faster startup matters more than guaranteed
# readiness.
#
# Idempotent: npm install is a no-op when the lockfile matches.

set -euo pipefail

# Only run in remote Claude Code on the web. Local dev environments
# already have node_modules managed by the developer.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

echo "[session-start] installing npm dependencies..."
npm install --no-audit --no-fund --prefer-offline 2>&1 | tail -20
echo "[session-start] npm install complete."
