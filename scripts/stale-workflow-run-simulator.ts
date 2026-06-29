#!/usr/bin/env tsx
/**
 * scripts/stale-workflow-run-simulator.ts   (npm run test:stale-workflow-run)
 * ─────────────────────────────────────────────────────────────────────────────
 * STALE WORKFLOW-RUN REAPER — proves the pure policy: a chain stuck mid-execution past threshold is
 * escalated (Campaign Orchestrator owns it), a fresh run keeps going, a chain PAUSED on a human is
 * never reaped, and terminal/unknown states are left alone. Pure: no I/O.
 */
import { classifyStaleWorkflowRun, WORKFLOW_RUN_STALE_HOURS } from "../lib/workflow-orchestrator/stale-run-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Stuck mid-execution → escalate]")
  check("running for 3h (>2h) → escalate", classifyStaleWorkflowRun({ status: "running", ageHours: 3 }) === "escalate")
  check("pending for 4h (>2h) → escalate", classifyStaleWorkflowRun({ status: "pending", ageHours: 4 }) === "escalate")

  console.log("\n[Fresh run → keep (let it execute)]")
  check("running for 0.3h → keep", classifyStaleWorkflowRun({ status: "running", ageHours: 0.3 }) === "keep")

  console.log("\n[Waiting on a human / terminal → never reaped]")
  check("paused (awaiting approval) → keep even after days", classifyStaleWorkflowRun({ status: "paused", ageHours: 240 }) === "keep")
  check("needs_approval → keep", classifyStaleWorkflowRun({ status: "needs_approval", ageHours: 240 }) === "keep")
  check("completed → keep", classifyStaleWorkflowRun({ status: "completed", ageHours: 999 }) === "keep")
  check("failed → keep", classifyStaleWorkflowRun({ status: "failed", ageHours: 999 }) === "keep")

  console.log("\n[Unknown non-terminal state → don't reap blindly]")
  check("unknown status → keep", classifyStaleWorkflowRun({ status: "weird", ageHours: 999 }) === "keep")
  check("thresholds cover running + pending", typeof WORKFLOW_RUN_STALE_HOURS.running === "number" && typeof WORKFLOW_RUN_STALE_HOURS.pending === "number")

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ STALE_RUN_FAIL"); process.exit(1) }
  console.log(" ✅ STALE_RUN_PASS — stalled chains get a manager owner; running + paused + terminal are left alone")
}
main()
