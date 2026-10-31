#!/usr/bin/env tsx
/**
 * scripts/wave144-canaries.ts — `npm run test:wave144-canaries` (wave 144, lane 144J)
 * ─────────────────────────────────────────────────────────────────────────────
 * The WAVE-144 OWNER-RULING canaries on the ONE canary runner (scripts/canaries/run-canaries.ts) — not a second runner:
 * this entry only selects the roster (CANARY_WAVE=144 → WAVE144_CANARY_KEYS in scripts/canaries/_registry.ts) and hands
 * over. `CANARY_ONLY=<key>[,<key>]` still narrows it. The runner exits non-zero while any ruling step is red and prints the
 * verdict table (green / red-awaiting-lane-X / red-defect) beside its RESULT line.
 *
 * Why a separate key and not CANARY_KEYS (the integrator's call once green): see the WAVE144_CANARY_KEYS doc in the registry.
 */
// Set BEFORE the runner is evaluated (a static import would be hoisted above this line); the runner calls main() on import.
process.env.CANARY_WAVE = "144"
void import("./canaries/run-canaries")
