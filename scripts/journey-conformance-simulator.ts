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

async function main() {
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

  console.log("\n[Layer 2 · live: audit a real illegal transition from lifecycle_events]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { auditJourneyConformance } = await import("../lib/journey-conformance/conformance-runner")
  const supabase = createServiceClient()
  const { data: brokerage } = await supabase.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const stamp = Date.now()
  const { data: contact } = await supabase.from("contacts").insert({
    brokerage_id: brokerageId, first_name: "ZZJourney", last_name: `Conf${stamp}`,
    email: `zz-journey-${stamp}@example.com`, contact_type: "buyer", source: "test",
  }).select("id").single()
  const contactId = (contact as any)?.id

  try {
    // A real illegal skip: contact created → touring, no financial verification, no override.
    await supabase.from("lifecycle_events").insert({
      brokerage_id: brokerageId, entity_type: "contact", entity_id: contactId,
      event_type: "contact.stage_advanced",
      metadata: { from_stage: "BUYER_CONTACT_CREATED", to_stage: "BUYER_TOURING" },
    })
    const audit = await auditJourneyConformance(contactId, brokerageId, { escalate: false }, supabase)
    check("the live illegal skip is caught (not compliant)", audit.compliant === false, JSON.stringify(audit.violations).slice(0, 120))
    check("flagged as illegal_transition AND gate_bypassed", audit.violations.some(v => v.type === "illegal_transition") && audit.violations.some(v => v.type === "gate_bypassed"))
  } finally {
    await supabase.from("lifecycle_events").delete().eq("entity_id", contactId).then(() => {}, () => {})
    await supabase.from("contacts").delete().eq("id", contactId)
    const { count } = await supabase.from("contacts").select("id", { count: "exact", head: true }).eq("id", contactId)
    check("cleanup: seed removed (count == 0)", (count ?? 0) === 0)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
