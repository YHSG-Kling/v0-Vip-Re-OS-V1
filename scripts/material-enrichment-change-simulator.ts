#!/usr/bin/env tsx
/**
 * scripts/material-enrichment-change-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the re-enrich → re-engage handoff core: materialEnrichmentChange detects when a
 * persona-drift refresh returned a genuinely NEW fact (new homeowner, job change, marital change,
 * new life event) — so the orchestrator stamps last_life_event_detected and the EXISTING life-event
 * detector (referral-radar) picks up the opportunity. Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/material-enrichment-change-simulator.ts   (npm run test:material-change)
 */
import { materialEnrichmentChange } from "../lib/lead-pipeline/material-enrichment-change"

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
  console.log(" ✅ Material change verified — real opportunities detected; refreshes-only ignored.")
  console.log(" MATERIAL_CHANGE_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Material enrichment change simulator")
  console.log("══════════════════════════════════════════════════\n")

  check("identical profile → no material change", !materialEnrichmentChange({ home_owner_status: "owner" }, { home_owner_status: "owner" }).changed)
  check("home ownership flip (renter→owner) → material", materialEnrichmentChange({ home_owner_status: "renter" }, { home_owner_status: "owner" }).changed)
  check("job change → material", materialEnrichmentChange({ job_title: "Teacher" }, { job_title: "Engineer" }).changed)
  check("marital status change → material (internal timing signal)", materialEnrichmentChange({ marital_status: "single" }, { marital_status: "married" }).changed)
  const le = materialEnrichmentChange({ life_events: [{ type: "job_change" }] }, { life_events: [{ type: "job_change" }, { type: "new_baby" }] })
  check("a NEW life event type → material (lists the event)", le.changed && le.changes.some((c) => /new_baby/.test(c)))
  check("first enrichment (no old value to compare) → NOT material (no false positive)", !materialEnrichmentChange({}, { home_owner_status: "owner", job_title: "Engineer" }).changed)
  check("null new profile → not changed (honest)", !materialEnrichmentChange({ home_owner_status: "owner" }, null).changed)

  report()
}

main()
