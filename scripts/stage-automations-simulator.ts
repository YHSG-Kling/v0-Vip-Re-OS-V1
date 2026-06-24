#!/usr/bin/env tsx
/**
 * scripts/stage-automations-simulator.ts  (npm run test:stage-automations)
 *
 * PURE guard against the case/name drift that silently left the listing stage automations not firing:
 * the action layer fires automations keyed on the CANONICAL UPPERCASE lifecycle stages, NOT the legacy
 * lowercase triggerStageActions vocabulary. This locks that mapping in so a future rename can't quietly
 * break the differentiator (CMA→presentation→drip→postcard) or the MLS packet again.
 */
import { stageAutomationFor } from "../lib/listing-lifecycle/stage-automations"
import { LISTING_LIFECYCLE_STAGES } from "../lib/listing-lifecycle/lifecycle-definitions"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

function main(): void {
  console.log("\n[stage automations · pure — canonical UPPERCASE stages fire the right automation]")
  check("APPOINTMENT_SET → listing_appt_prep (CMA→presentation→drip→postcard)", stageAutomationFor("APPOINTMENT_SET") === "listing_appt_prep")
  check("MLS_ACTIVE → mls_packet", stageAutomationFor("MLS_ACTIVE") === "mls_packet")
  check("a non-automated stage → null", stageAutomationFor("SELLER_DECISION") === null)

  console.log("\n[stage automations · pure — the LEGACY lowercase names DON'T match (the drift that broke it)]")
  check("'appointment_scheduled' (legacy) → null, not a silent match", stageAutomationFor("appointment_scheduled") === null)
  check("'mls_active' (legacy lowercase) → null", stageAutomationFor("mls_active") === null)
  check("'appointment_set' (wrong case) → null", stageAutomationFor("appointment_set") === null)

  console.log("\n[stage automations · pure — the mapped stages EXIST in the canonical definitions]")
  const defined = new Set((LISTING_LIFECYCLE_STAGES as Array<{ stage: string }>).map((s) => s.stage))
  check("APPOINTMENT_SET is a real canonical stage", defined.has("APPOINTMENT_SET"))
  check("MLS_ACTIVE is a real canonical stage", defined.has("MLS_ACTIVE"))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ STAGE_AUTOMATIONS_FAIL"); process.exit(1) }
  console.log(" ✅ STAGE_AUTOMATIONS_PASS — stage automations are keyed to the canonical stages, drift-guarded")
}

main()
