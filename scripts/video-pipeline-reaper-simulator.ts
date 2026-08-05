#!/usr/bin/env tsx
/**
 * scripts/video-pipeline-reaper-simulator.ts   (npm run test:video-pipeline-reaper)
 * ─────────────────────────────────────────────────────────────────────────────
 * STALE VIDEO-WORKFLOW REAPER — proves the pure policy: a Director reel stuck past its state threshold
 * is escalated (a manager owns it), a fresh one is left to run, terminal/agent-blocked rows are never
 * reaped, and unknown states aren't reaped blindly. Pure: no I/O.
 */
import { classifyStaleVideo, VIDEO_STALE_HOURS } from "../lib/video/video-pipeline-reaper-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Stalled past threshold → escalate]")
  check("generating for 4h (>3h) → escalate", classifyStaleVideo({ status: "generating", ageHours: 4 }) === "escalate")
  check("queued for 3h (>2h) → escalate", classifyStaleVideo({ status: "queued", ageHours: 3 }) === "escalate")
  check("queued for 5h (>2h) → escalate", classifyStaleVideo({ status: "queued", ageHours: 5 }) === "escalate")

  console.log("\n[Still within the window → keep (let the crons finish it)]")
  check("generating for 0.5h → keep", classifyStaleVideo({ status: "generating", ageHours: 0.5 }) === "keep")
  check("queued for 0.2h → keep", classifyStaleVideo({ status: "queued", ageHours: 0.2 }) === "keep")

  console.log("\n[Terminal + agent-blocked are never reaped]")
  check("completed → keep", classifyStaleVideo({ status: "completed", ageHours: 999 }) === "keep")
  check("failed → keep", classifyStaleVideo({ status: "failed", ageHours: 999 }) === "keep")
  check("awaiting_presenter_setup (blocked on the agent) → keep, never reaped", classifyStaleVideo({ status: "awaiting_presenter_setup", ageHours: 999 }) === "keep")

  console.log("\n[Unknown non-terminal state → don't reap blindly]")
  check("unknown status → keep", classifyStaleVideo({ status: "some_new_state", ageHours: 999 }) === "keep")
  // m374 merged the three Director non-terminal spellings into two:
  // remotion_pending → queued, and rendering → generating. Both surviving
  // states must still carry a threshold or a stalled reel is never escalated.
  check("thresholds cover both Director non-terminal states",
    ["queued", "generating"].every((s) => typeof VIDEO_STALE_HOURS[s] === "number"))
  // …and the retired spellings must not linger as thresholds, which would be a
  // rule keyed to a value the CHECK constraint now refuses.
  check("no retired spelling still carries a threshold",
    ["remotion_pending", "rendering", "audio_ready", "submitting", "awaiting_provider"]
      .every((s) => VIDEO_STALE_HOURS[s] === undefined))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VIDEO_REAPER_FAIL"); process.exit(1) }
  console.log(" ✅ VIDEO_REAPER_PASS — stalled reels get a manager owner; running + terminal + blocked rows are left alone")
}
main()
