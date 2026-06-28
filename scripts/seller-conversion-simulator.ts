#!/usr/bin/env tsx
/**
 * scripts/seller-conversion-simulator.ts   (npm run test:seller-conversion)
 * ─────────────────────────────────────────────────────────────────────────────
 * SELLER-CONVERSION NURTURE — proves the seller mirror of the buyer nurture: an un-converted seller
 * (a contact with a seller-mode portal who hasn't booked a listing consult) is handed to the MULTI-
 * MANAGER reel chain (Listing Concierge → Asset Manager → Campaign Orchestrator), not a one-off
 * hardcoded email. Pure layer: the candidate predicate + the Director situation (CUSTOMER-FACING, not
 * the in_house cma). No I/O. The bus round-trip (signal → handoff → gated reel → portal delivery) is
 * proven by the live round-trip in the PR.
 */
import { isUnconvertedSellerCandidate } from "../lib/agents/seller-conversion-eligibility"
import { buildSellerConversionSituation } from "../lib/ai-isa/contact-reel-situation"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  const none = new Set<string>()

  console.log("\n[Candidate predicate — who is an un-converted seller worth nurturing]")
  check("home-value requester (has an estimate) qualifies", isUnconvertedSellerCandidate({ home_value_estimate: 540000, contact_type: null, motivation_type: null }, none, "c1"))
  check("declared seller (contact_type) qualifies", isUnconvertedSellerCandidate({ home_value_estimate: null, contact_type: "seller", motivation_type: null }, none, "c2"))
  check("declared seller (motivation_type) qualifies", isUnconvertedSellerCandidate({ home_value_estimate: null, contact_type: null, motivation_type: "seller" }, none, "c3"))
  check("a buyer with no seller signal does NOT qualify", !isUnconvertedSellerCandidate({ home_value_estimate: null, contact_type: "buyer", motivation_type: "buyer" }, none, "c4"))
  check("zero/blank home value alone does NOT qualify", !isUnconvertedSellerCandidate({ home_value_estimate: 0, contact_type: null, motivation_type: null }, none, "c5"))

  console.log("\n[Already-represented sellers are excluded — they're converted, not a conversion target]")
  const represented = new Set<string>(["c6"])
  check("a seller we already list for is skipped", !isUnconvertedSellerCandidate({ home_value_estimate: 700000, contact_type: "seller", motivation_type: "seller" }, represented, "c6"))
  check("a different un-converted seller still qualifies", isUnconvertedSellerCandidate({ home_value_estimate: 700000, contact_type: "seller", motivation_type: null }, represented, "c7"))

  console.log("\n[Director situation — the reel must REACH the seller (customer-facing, not in_house)]")
  const s = buildSellerConversionSituation({ contactId: "c1" })
  check("kind is 'lead_intro' (customer-facing) — NOT 'cma' (which the Director marks in_house/agent-only)", s.kind === "lead_intro")
  check("kind is never the agent-only 'cma' or 'presentation'", s.kind !== "cma" && s.kind !== "presentation")
  check("persona is seller", (s.facts as any).persona === "seller")
  check("moment seeds the gateway script as seller_conversion", (s.facts as any).moment === "seller_conversion")
  check("carries the contactId for the presenter + delivery", (s.facts as any).contactId === "c1")

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SELLER_CONVERSION_FAIL"); process.exit(1) }
  console.log(" ✅ SELLER_CONVERSION_PASS — un-converted sellers are handed to the multi-manager reel chain, customer-facing, no hardcoded copy")
}

main()
