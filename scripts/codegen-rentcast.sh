#!/usr/bin/env bash
# scripts/codegen-rentcast.sh
# Regenerate lib/external/_generated/rentcast-openapi.ts from the upstream OpenAPI spec.
# Run this whenever RentCast publishes a new spec version so type-check picks up the change
# (compile-time drift detection instead of 4xx/5xx in production).
set -euo pipefail

SPEC_URL="${SPEC_URL:-https://raw.githubusercontent.com/RentCast/api-resources/main/openapi-spec/rentcast_api_openapi_spec_v1.json}"
OUT="${OUT:-lib/external/_generated/rentcast-openapi.ts}"

mkdir -p "$(dirname "$OUT")"
node_modules/.bin/openapi-typescript "$SPEC_URL" --output "$OUT"
echo "✓ Regenerated $OUT from $SPEC_URL"
