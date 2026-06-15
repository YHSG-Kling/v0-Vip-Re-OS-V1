#!/usr/bin/env tsx
/**
 * scripts/journey-conformance-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE JOURNEY-CONFORMANCE MONITOR — the live-data audit that every entity's ACTUAL stage
 * transitions obeyed the constitutional JOURNEY_PROGRESS_CONTRACT (legal order + hard gates).
 * Pure replay over a transition history. An authorized override is a logged exception (noted, not
 * a violation); the ABSENCE of one on an illegal skip / bypassed gate IS the violation.
 *
 * Run: npx tsx scripts/journey-conformance-simulator.ts   (npm run test:journey-conformance)
 */
import { checkJourneyConformance, type ConformanceConfig, type JourneyTransition } from "../lib/journey-conformance/conformance-checker"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Journey conformance verified — illegal skips + bypassed gates caught, overrides honored.")
  console.log(" JOURNEY_CONFORMANCE_PASS")
}

// Buyer journey config (mirrors JOURNEY_PROGRESS_CONTRACT: financial verification is the hard gate).
const config: ConformanceConfig = {
  legalMap: {
    BUYER_FINANCIALLY_VERIFIED: ["BUYER_CONTACT_CREATED"],
    BUYER_SEARCH_CONFIGURED: ["BUYER_FINANCIALLY_VERIFIED"],
    BUYER_SEARCHING: ["BUYER_SEARCH_CONFIGURED"],
    BUYER_TOURING: ["BUYER_SEARCHING"],
    BUYER_OFFER_ELIGIBLE: ["BUYER_TOURING"],
  },
  gatedStates: new Set(["BUYER_SEARCH_CONFIGURED", "BUYER_SEARCHING", "BUYER_TOURING", "BUYER_OFFER_ELIGIBLE"]),
  gateSatisfiedState: "BUYER_FINANCIALLY_VERIFIED",
}
const T = (from: string, to: string, override = false): JourneyTransition => ({ from, to, override })

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Journey-conformance simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Compliant path]")
  const ok = checkJourneyConformance([
    T("BUYER_CONTACT_CREATED", "BUYER_FINANCIALLY_VERIFIED"),
    T("BUYER_FINANCIALLY_VERIFIED", "BUYER_SEARCH_CONFIGURED"),
    T("BUYER_SEARCH_CONFIGURED", "BUYER_SEARCHING"),
    T("BUYER_SEARCHING", "BUYER_TOURING"),
  ], config)
  check("a contract-following path is COMPLIANT (0 violations)", ok.compliant && ok.violations.length === 0 && ok.overridesUsed === 0)
  check("transitions counted", ok.transitionsChecked === 4)

  console.log("\n[Illegal skip + bypassed gate]")
  const skip = checkJourneyConformance([T("BUYER_CONTACT_CREATED", "BUYER_TOURING")], config)
  check("jumping straight to touring is NOT compliant", !skip.compliant)
  check("it's flagged an illegal transition (touring can't follow contact_created)", skip.violations.some(v => v.type === "illegal_transition" && v.to === "BUYER_TOURING"))
  check("AND the financial-verification hard gate is flagged bypassed", skip.violations.some(v => v.type === "gate_bypassed" && v.to === "BUYER_TOURING"))

  console.log("\n[Hard gate isolated — an override skipped verification]")
  const gate = checkJourneyConformance([
    T("BUYER_CONTACT_CREATED", "BUYER_SEARCH_CONFIGURED", true), // authorized override past verification
    T("BUYER_SEARCH_CONFIGURED", "BUYER_SEARCHING"),            // legal order, but the gate was never passed
  ], config)
  check("the override is counted (a logged exception, not a violation)", gate.overridesUsed === 1)
  check("the legal-but-ungated transition trips the GATE check only", gate.violations.length === 1 && gate.violations[0].type === "gate_bypassed")
  check("not flagged as an illegal transition (the order was legal)", !gate.violations.some(v => v.type === "illegal_transition"))

  console.log("\n[Authorized override is honored]")
  const override = checkJourneyConformance([T("BUYER_CONTACT_CREATED", "BUYER_TOURING", true)], config)
  check("an authorized override bypasses BOTH checks → compliant, 1 override", override.compliant && override.violations.length === 0 && override.overridesUsed === 1)

  console.log("\n[Empty]")
  check("no transitions → compliant (nothing to audit)", checkJourneyConformance([], config).compliant)

  report()
}

main()
