#!/bin/bash
# generate-heygen-video.sh
# Usage: ./scripts/generate-heygen-video.sh --avatar-id <id> --voice-id <id> --script "text" --output-name <name>
# Requires: HEYGEN_API_KEY env var

set -e

export HEYGEN_API_KEY="${HEYGEN_API_KEY:-$(grep HEYGEN_API_KEY .env.local 2>/dev/null | cut -d= -f2)}"

if [ -z "$HEYGEN_API_KEY" ]; then
  echo "ERROR: HEYGEN_API_KEY not set"
  exit 1
fi

echo "Generating HeyGen video..."
heygen video create "$@" 2>&1 || echo "Note: heygen CLI may require auth. Use the API routes instead."
