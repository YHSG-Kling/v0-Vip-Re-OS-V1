#!/bin/bash
set -euo pipefail

# Pre-install the Supabase MCP server so the plugin's MCP server starts fast
# and without a registry round-trip at session launch. Web sessions only.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Idempotent: npm install -g is safe to re-run and benefits from container caching.
npm install -g @supabase/mcp-server-supabase >/dev/null 2>&1 || true
