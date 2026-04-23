#!/usr/bin/env bash
# scripts/heygen-create-video.sh
#
# Create a HeyGen presenter video via the v3 Video Agent CLI.
#
# Setup (one-time):
#   curl -fsSL https://static.heygen.ai/cli/install.sh | bash
#   heygen auth login   (or set HEYGEN_API_KEY in env)
#
# Required env vars (add to .env.local or Vercel):
#   HEYGEN_API_KEY     — HeyGen API key
#   HEYGEN_AVATAR_ID   — Look ID from `heygen avatar looks list --group-id <id>`
#   HEYGEN_VOICE_ID    — Voice ID from `heygen voice list`
#
# Usage:
#   ./scripts/heygen-create-video.sh --title "Q2 Market Update" --script "Your script here..."
#   ./scripts/heygen-create-video.sh --title "Listing Intro" --script-file /path/to/script.txt

set -euo pipefail

TITLE=""
SCRIPT_TEXT=""
SCRIPT_FILE=""
ORIENTATION="landscape"
LOG_FILE="$(dirname "$0")/heygen-video-log.jsonl"

usage() {
  echo "Usage: $0 --title <title> [--script <text>] [--script-file <path>] [--orientation landscape|portrait]"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)        TITLE="$2";       shift 2 ;;
    --script)       SCRIPT_TEXT="$2"; shift 2 ;;
    --script-file)  SCRIPT_FILE="$2"; shift 2 ;;
    --orientation)  ORIENTATION="$2"; shift 2 ;;
    *)              usage ;;
  esac
done

[[ -z "$TITLE" ]] && { echo "Error: --title is required"; usage; }

# Load env from .env.local if present
ENV_FILE="$(dirname "$0")/../.env.local"
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi

# Validate prerequisites
if ! command -v heygen &>/dev/null; then
  echo "Error: heygen CLI not found."
  echo "Install: curl -fsSL https://static.heygen.ai/cli/install.sh | bash"
  echo "Auth:    heygen auth login   (or set HEYGEN_API_KEY)"
  exit 1
fi

JQ_AVAILABLE=false
if command -v jq &>/dev/null; then
  JQ_AVAILABLE=true
fi

# HEYGEN_API_KEY is optional — the CLI can use `heygen auth login` session tokens instead.
# If neither an API key nor a CLI auth session is available, the `heygen` command itself
# will fail with an authentication error.
if [[ -z "${HEYGEN_API_KEY:-}" ]]; then
  echo "Note: HEYGEN_API_KEY is not set; relying on CLI auth session (heygen auth login)."
fi

# Resolve script text
if [[ -n "$SCRIPT_FILE" ]]; then
  SCRIPT_TEXT="$(<"$SCRIPT_FILE")"
fi
[[ -z "$SCRIPT_TEXT" ]] && { echo "Error: --script or --script-file is required"; usage; }

# Build CLI flags
ARGS=(
  "--prompt" "$SCRIPT_TEXT"
  "--orientation" "$ORIENTATION"
  "--wait"
)
[[ -n "${HEYGEN_AVATAR_ID:-}" ]] && ARGS+=("--avatar-id" "$HEYGEN_AVATAR_ID")
[[ -n "${HEYGEN_VOICE_ID:-}" ]]  && ARGS+=("--voice-id"  "$HEYGEN_VOICE_ID")

echo "Creating video: $TITLE"
RESULT=$(heygen video-agent create "${ARGS[@]}")

VIDEO_URL=""
SESSION_ID=""
if $JQ_AVAILABLE; then
  VIDEO_URL=$(echo "$RESULT" | jq -r '.video_url // .share_url // empty' 2>/dev/null || true)
  SESSION_ID=$(echo "$RESULT" | jq -r '.session_id // empty' 2>/dev/null || true)
fi

# Log to JSONL (requires jq for safe JSON encoding)
if $JQ_AVAILABLE; then
  echo "{\"created_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"title\":$(echo "$TITLE" | jq -Rs .),\"session_id\":$(echo "${SESSION_ID:-}" | jq -Rs .),\"video_url\":$(echo "${VIDEO_URL:-}" | jq -Rs .),\"avatar_id\":$(echo "${HEYGEN_AVATAR_ID:-}" | jq -Rs .),\"voice_id\":$(echo "${HEYGEN_VOICE_ID:-}" | jq -Rs .)}" >> "$LOG_FILE"
else
  echo "Note: jq not found — skipping JSONL log entry for this run."
fi

if [[ -n "$VIDEO_URL" ]]; then
  echo "Done: $VIDEO_URL"
else
  echo "Session: $SESSION_ID"
  echo "Check status: heygen video-agent get $SESSION_ID"
fi
