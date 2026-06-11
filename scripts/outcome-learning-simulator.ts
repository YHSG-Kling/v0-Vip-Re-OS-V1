#!/usr/bin/env tsx
/**
 * scripts/outcome-learning-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OUTCOME LEARNING harness — the human's decisions tune the team.
 *
 * Pure (no DB needed — scoring is the contract):
 *   · only HUMAN decisions count: peer-review vetoes + team-play supersedes are
 *     machine actions and NEVER punish a manager
 *   · trusted until proven otherwise: small samples (< MIN_DECISIONS) gate nothing
 *   · a real sample below the threshold pauses INITIATIVE (idle-hands consults this)
 *
 * Run: npx tsx scripts/outcome-learning-simulator.ts  (npm run test:outcome-learning)
 */
import { scoreOutcomes, isManagerTrusted, summarizeRejectionFeedback, MIN_DECISIONS, TRUST_THRESHOLD, type DecidedProposal } from "../lib/kernel/outcome-learning"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const human = (kind: string, ok: boolean): DecidedProposal => ({
  agent_kind: kind, status: ok ? "approved" : "rejected",
  approved_by: ok ? "user-1" : null, send_error: null,
})
const veto = (kind: string): DecidedProposal => ({
  agent_kind: kind, status: "rejected", approved_by: null,
  send_error: "vetoed by peer review (Campaign Orchestrator): relationship is WITHDRAWN",
})
const superseded = (kind: string): DecidedProposal => ({
  agent_kind: kind, status: "rejected", approved_by: null,
  send_error: "superseded by team play abc-123",
})

console.log("══════════════════════════════════════════════════")
console.log(" Outcome learning simulator")
console.log("══════════════════════════════════════════════════\n")

// Machine actions never count.
const machineHeavy = scoreOutcomes([
  ...Array.from({ length: 20 }, () => veto("sphere_of_influence")),
  ...Array.from({ length: 20 }, () => superseded("sphere_of_influence")),
  human("sphere_of_influence", true),
])
check("machine vetoes + supersedes EXCLUDED (1 human decision counted, not 41)",
  machineHeavy["sphere_of_influence"].decisions === 1 && machineHeavy["sphere_of_influence"].approvalRate === 1)
check("machine-heavy manager stays TRUSTED", isManagerTrusted(machineHeavy, "sphere_of_influence"))

// Small samples gate nothing.
const small = scoreOutcomes(Array.from({ length: MIN_DECISIONS - 1 }, () => human("ai_isa", false)))
check(`small sample (< ${MIN_DECISIONS}) gates nothing — trusted until proven otherwise`, isManagerTrusted(small, "ai_isa"))

// A real rejected sample pauses initiative.
const distrusted = scoreOutcomes([
  ...Array.from({ length: 3 }, () => human("marketing_agent", true)),
  ...Array.from({ length: 12 }, () => human("marketing_agent", false)),
])
check(`real sample below ${TRUST_THRESHOLD * 100}% approval → initiative PAUSED`,
  !isManagerTrusted(distrusted, "marketing_agent") && distrusted["marketing_agent"].approvalRate === 0.2)

// A healthy manager stays trusted; per-manager isolation.
const mixed = scoreOutcomes([
  ...Array.from({ length: 15 }, () => human("shopping_agent", true)),
  ...Array.from({ length: 12 }, () => human("marketing_agent", false)),
])
check("healthy manager trusted while the rejected one is paused (per-manager isolation)",
  isManagerTrusted(mixed, "shopping_agent") && !isManagerTrusted(mixed, "marketing_agent"))
check("rates are exact (15/15 approved = 1.0; 0/12 = 0.0)",
  mixed["shopping_agent"].approvalRate === 1 && mixed["marketing_agent"].approvalRate === 0)

// DIRECTION, not just a score: the human's spoken reasons are summarized per manager.
const withReasons = summarizeRejectionFeedback([
  { agent_kind: "marketing_agent", status: "rejected", approved_by: "u1", send_error: "agent feedback: too pushy" },
  { agent_kind: "marketing_agent", status: "rejected", approved_by: "u1", send_error: "agent feedback: wrong tone" },
  veto("marketing_agent"),
  { agent_kind: "sphere_of_influence", status: "rejected", approved_by: "u1", send_error: null },
  ...Array.from({ length: 5 }, (_, i) => ({ agent_kind: "marketing_agent", status: "rejected", approved_by: "u1", send_error: `agent feedback: r${i}` })),
])
check("feedback: 'agent feedback:' reasons extracted per manager, capped at 3",
  withReasons["marketing_agent"].length === 3 && withReasons["marketing_agent"][0] === "too pushy")
check("feedback: machine vetoes + reasonless rejections never appear",
  !withReasons["marketing_agent"].some((f) => f.includes("vetoed")) && !withReasons["sphere_of_influence"])
const fbScore = scoreOutcomes([
  { agent_kind: "ai_isa", status: "rejected", approved_by: "u1", send_error: "agent feedback: too long" },
])
check("a reasoned rejection still COUNTS as a human rejection in the score",
  fbScore["ai_isa"].rejected === 1)

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(" ✅ Outcome learning verified — human feedback, faithfully counted")
