#!/usr/bin/env tsx
/**
 * scripts/mls-number-reminder-simulator.ts   (npm run test:mls-number-reminder)
 * ─────────────────────────────────────────────────────────────────────────────
 * MLS-NUMBER ENTRY REMINDER — proves the pure eligibility: a LIVE listing with NO MLS number and an
 * agent to prompt is the only thing reminded (so the seller portal's syndication status can flip
 * honestly to live once the number is entered). Not-live, already-numbered, or agentless → no nudge.
 */
import { needsMlsNumberReminder } from "../lib/listings/mls-reminder-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  check("live + no MLS number + agent → REMIND", needsMlsNumberReminder({ isLiveListing: true, hasMlsNumber: false, hasAgent: true }))
  check("live + HAS MLS number → no nudge (already syndicating)", !needsMlsNumberReminder({ isLiveListing: true, hasMlsNumber: true, hasAgent: true }))
  check("NOT live (prep/coming-soon) → no nudge", !needsMlsNumberReminder({ isLiveListing: false, hasMlsNumber: false, hasAgent: true }))
  check("no agent to prompt → no nudge", !needsMlsNumberReminder({ isLiveListing: true, hasMlsNumber: false, hasAgent: false }))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MLS_REMINDER_FAIL"); process.exit(1) }
  console.log(" ✅ MLS_REMINDER_PASS — only live, un-numbered, agent-owned listings get the one-time nudge")
}
main()
