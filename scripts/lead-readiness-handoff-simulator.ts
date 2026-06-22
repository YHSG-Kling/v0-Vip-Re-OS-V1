#!/usr/bin/env tsx
/**
 * scripts/lead-readiness-handoff-simulator.ts  (npm run test:lead-readiness-handoff) — pure, no DB.
 *
 * Proves the human-readable handoff context (lib/lead-readiness/readiness-evaluator.ts
 * generateHandoffContext) rendered by the new Lead Readiness panel on /leads/[leadId]:
 * status line, explanation, recommended action, staleness, and warnings all surface so a
 * broker can make the handoff decision at a glance.
 */
import { generateHandoffContext, type ReadinessEvaluation } from "../lib/lead-readiness/readiness-evaluator"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

console.log("\n[lead-readiness handoff context · pure]")

const ready: ReadinessEvaluation = {
  state: "ready_for_assignment",
  explanation: "Lead is qualified (score: 72) and ready for agent assignment.",
  recommendedAction: "Assign to an available buyer agent.",
  warnings: [],
}
const readyOut = generateHandoffContext(ready)
check("status line reflects the state (uppercased, spaced)", readyOut.includes("READY FOR ASSIGNMENT"))
check("explanation surfaces", readyOut.includes("qualified (score: 72)"))
check("recommended action surfaces", readyOut.includes("Recommended Action:") && readyOut.includes("Assign to an available buyer agent"))
check("no warnings section when clean", !readyOut.includes("Warnings:"))

const stalled: ReadinessEvaluation = {
  state: "stalled_no_response",
  explanation: "No response in 9 days.",
  recommendedAction: "Trigger re-engagement cadence.",
  staleDays: 9,
  warnings: ["Low confidence scores detected", "No phone on file"],
}
const stalledOut = generateHandoffContext(stalled)
check("staleness days surface", stalledOut.includes("Days Since Last Activity:") && stalledOut.includes("9"))
check("each warning is listed", stalledOut.includes("Low confidence scores detected") && stalledOut.includes("No phone on file"))
check("broker-review state renders distinctly", generateHandoffContext({ ...stalled, state: "broker_review_required" }).includes("BROKER REVIEW REQUIRED"))

console.log("\n──────────────────────────────────────────────────")
if (fail > 0) { console.log(` RESULT: ${pass} passed, ${fail} failed`); process.exit(1) }
console.log(` RESULT: ${pass} passed, 0 failed`)
console.log(" ✅ LEAD_READINESS_HANDOFF_PASS — handoff context surfaces state, action, staleness + warnings")
