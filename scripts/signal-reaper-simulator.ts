#!/usr/bin/env tsx
/**
 * scripts/signal-reaper-simulator.ts   (npm run test:signal-reaper)
 * ─────────────────────────────────────────────────────────────────────────────
 * NO SIGNAL FALLS THROUGH THE CRACKS — proves the reaper policy: a HANDLED handoff that hasn't
 * resolved within its window is escalated to a human (never silently lost); a FEED_ONLY signal clears
 * after its display TTL; anything still inside its window is kept (the dispatcher keeps retrying).
 * Pure: no I/O.
 */
import {
  shouldReapSignal, MAX_HANDLED_OPEN_HOURS, FEED_ONLY_TTL_HOURS,
} from "../lib/kernel/signal-reaper-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Handled handoff — must complete or escalate to a human]")
  check("fresh handled (1h) → keep (dispatcher still retrying)", shouldReapSignal({ ageHours: 1, disposition: "handled" }) === "keep")
  check("handled just under window → keep", shouldReapSignal({ ageHours: MAX_HANDLED_OPEN_HOURS - 0.1, disposition: "handled" }) === "keep")
  check("handled past window → expire_escalate (alert a human, never drop)", shouldReapSignal({ ageHours: MAX_HANDLED_OPEN_HOURS, disposition: "handled" }) === "expire_escalate")
  check("very old handled → expire_escalate", shouldReapSignal({ ageHours: 1000, disposition: "handled" }) === "expire_escalate")

  console.log("\n[Feed-only — informational, no task owed; clear after the display TTL]")
  check("feed_only at 24h → keep (still on the feed)", shouldReapSignal({ ageHours: 24, disposition: "feed_only" }) === "keep")
  check("feed_only past TTL → expire_quiet (no escalation)", shouldReapSignal({ ageHours: FEED_ONLY_TTL_HOURS, disposition: "feed_only" }) === "expire_quiet")

  console.log("\n[Invariant — a handled signal never quietly disappears, a feed one never escalates]")
  check("handled is NEVER expire_quiet", [0, 24, 48, 1000].every((h) => shouldReapSignal({ ageHours: h, disposition: "handled" }) !== "expire_quiet"))
  check("feed_only is NEVER expire_escalate", [0, 168, 1000].every((h) => shouldReapSignal({ ageHours: h, disposition: "feed_only" }) !== "expire_escalate"))
  check("handled window (24h) is tighter than feed TTL (168h)", MAX_HANDLED_OPEN_HOURS < FEED_ONLY_TTL_HOURS)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SIGNAL_REAPER_FAIL"); process.exit(1) }
  console.log(" ✅ SIGNAL_REAPER_PASS — every stuck signal resolves: handled→escalate+expire, feed→expire; nothing falls through the cracks")
}

main()
