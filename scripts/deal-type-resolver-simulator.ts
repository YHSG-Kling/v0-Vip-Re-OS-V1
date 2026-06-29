#!/usr/bin/env tsx
/**
 * scripts/deal-type-resolver-simulator.ts   (npm run test:deal-type-resolver)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves deal_type is resolved from GROUND TRUTH, never an in-house/buyer assumption: an external/IDX
 * target is 'buyer'; our listing with a DIFFERENT in-house agent on the buyer side is 'dual' (the common
 * in-house-both-sides deal); our listing with the same agent / an outside buyer is 'seller'. Pure: no I/O.
 */
import { resolveDealType } from "../lib/transactions/deal-type-resolver"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[deal_type resolution]")
  check("external listing (not ours) → buyer (we represent the buyer only)",
    resolveDealType({ ourListing: false, buyerAgentId: "ag_buyer", listingAgentId: null }) === "buyer")
  check("external listing stays buyer even with agents present",
    resolveDealType({ ourListing: false, buyerAgentId: "ag_buyer", listingAgentId: "ag_list" }) === "buyer")

  check("our listing + DIFFERENT in-house agent on buyer side → dual",
    resolveDealType({ ourListing: true, buyerAgentId: "ag_buyer", listingAgentId: "ag_list" }) === "dual")
  check("our listing + SAME agent both sides → seller (single-agent or logged outside offer)",
    resolveDealType({ ourListing: true, buyerAgentId: "ag_x", listingAgentId: "ag_x" }) === "seller")
  check("our listing + no buyer agent → seller",
    resolveDealType({ ourListing: true, buyerAgentId: null, listingAgentId: "ag_list" }) === "seller")
  check("our listing + no listing agent → seller (can't confirm a distinct buyer side)",
    resolveDealType({ ourListing: true, buyerAgentId: "ag_buyer", listingAgentId: null }) === "seller")

  console.log("\n[every output is a valid deal_type CHECK value]")
  const outputs = [
    resolveDealType({ ourListing: false, buyerAgentId: null, listingAgentId: null }),
    resolveDealType({ ourListing: true, buyerAgentId: "a", listingAgentId: "b" }),
    resolveDealType({ ourListing: true, buyerAgentId: "a", listingAgentId: "a" }),
  ]
  check("outputs ⊆ {buyer, seller, dual}", outputs.every((o) => ["buyer", "seller", "dual"].includes(o)))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ DEAL_TYPE_RESOLVER_FAIL"); process.exit(1) }
  console.log(" ✅ DEAL_TYPE_RESOLVER_PASS — buyer / seller / dual resolved from ground truth, no in-house assumption")
}
main()
