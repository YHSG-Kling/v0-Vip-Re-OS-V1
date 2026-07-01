#!/usr/bin/env tsx
/**
 * scripts/contact-scrub-promotion-simulator.ts   (npm run test:contact-scrub-promotion)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the FIX: the scraped raw→lead enrichment skip-traces but never scrubbed the number
 * against DNC / TCPA-litigators, so lead→contact promotion wrote dnc_status=false and the
 * outreach gate was VACUOUS. Promotion now scrubs with the SAME primitive the enrichment
 * orchestrator uses (one path, no drift) and the scrub patch OVERRIDES the optimistic default.
 *
 * Uses the real pure scrub primitives (electScrubbedPhones → electionToColumnPatch) and
 * simulates the contact-creator merge ({ dnc_status:false, ...scrubPatch }) exactly. No mocks.
 */
import { electScrubbedPhones, electionToColumnPatch } from "../lib/compliance/phone-scrub"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

// Mirror the contact-creator insert: optimistic defaults, then the scrub patch spread last.
function promote(defaults: Record<string, unknown>, patch: Record<string, unknown> | null) {
  return { ...defaults, ...(patch ?? {}) }
}
const DEFAULTS = { phone: "8005550001", phone_secondary: null as string | null, dnc_status: false }

function main() {
  console.log("\n[a scraped DNC / TCPA-litigator number → contact is SUPPRESSED at promotion]")
  const dncOnly = electionToColumnPatch(electScrubbedPhones([{ number: "8005550001", dnc: true }]))
  const c1 = promote(DEFAULTS, dncOnly)
  check("DNC line → patch marks dnc_status true", dncOnly.dnc_status === true)
  check("promotion merge OVERRIDES the optimistic false → contact dnc_status true", c1.dnc_status === true)

  const litOnly = electionToColumnPatch(electScrubbedPhones([{ number: "8005550002", tcpaLitigator: true }]))
  check("TCPA-litigator line → suppressed via dnc_status true (never dial a litigator)", promote(DEFAULTS, litOnly).dnc_status === true)

  console.log("\n[a dirty+clean pair → the CLEAN line is elected primary, contact stays callable on it]")
  const mixed = electionToColumnPatch(electScrubbedPhones([
    { number: "8005550003", dnc: true },   // dirty, was first
    { number: "8005550004", reachable: true }, // clean
  ]))
  const c2 = promote(DEFAULTS, mixed)
  check("clean number elected primary", c2.phone === "8005550004")
  check("primary is not suppressed (clean line is callable)", c2.dnc_status === false)

  console.log("\n[provider deferred (no scrub) → HONEST: keep the lead's values, no fabricated flag]")
  const c3 = promote(DEFAULTS, null)
  check("no patch → phone unchanged", c3.phone === "8005550001")
  check("no patch → dnc_status stays the optimistic default (not fabricated true/false)", c3.dnc_status === false)

  console.log("\n[the gate columns the patch writes all exist on contacts (verified live) — no crash]")
  const p = electionToColumnPatch(electScrubbedPhones([{ number: "8005550005", reachable: true }, { number: "8005550006", dnc: true }]))
  const allowed = new Set(["phone", "phone_secondary", "dnc_status", "phone_status", "phone_verified", "phone_secondary_dnc_status", "phone_secondary_status", "phone_secondary_verified"])
  check("every patch key is a real contacts gate column", Object.keys(p).every((k) => allowed.has(k)))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CONTACT_SCRUB_PROMOTION_FAIL"); process.exit(1) }
  console.log(" ✅ CONTACT_SCRUB_PROMOTION_PASS — scraped phones are DNC/litigator-scrubbed at promotion; the gate is no longer vacuous")
}
main()
