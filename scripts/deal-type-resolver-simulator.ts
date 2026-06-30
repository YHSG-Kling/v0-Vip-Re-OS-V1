#!/usr/bin/env tsx
/**
 * scripts/deal-type-resolver-simulator.ts   (npm run test:deal-type-resolver)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves deal_type is resolved from GROUND TRUTH, never an in-house/buyer assumption: an external/IDX
 * target is 'buyer'; our listing with OUR buyer (in our pipeline) is 'dual' — covering BOTH the two-agent
 * in-house deal AND single-agent dual agency (the distinguishing fact is "is the buyer ours", not how
 * many agents); our listing with an OUTSIDE buyer (mail/upload intake, no buyer pipeline) is 'seller'.
 * Pure: no I/O.
 */
import { resolveDealType } from "../lib/transactions/deal-type-resolver"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[deal_type resolution]")
  check("external listing (not ours) → buyer (we represent the buyer only)",
    resolveDealType({ ourListing: false, ourBuyer: true }) === "buyer")
  check("external listing stays buyer regardless of ourBuyer flag",
    resolveDealType({ ourListing: false, ourBuyer: false }) === "buyer")

  check("our listing + OUR buyer → dual (covers two-agent AND single-agent dual)",
    resolveDealType({ ourListing: true, ourBuyer: true }) === "dual")
  check("our listing + OUTSIDE buyer (no buyer pipeline) → seller",
    resolveDealType({ ourListing: true, ourBuyer: false }) === "seller")

  console.log("\n[every output is a valid deal_type CHECK value]")
  const outputs = [
    resolveDealType({ ourListing: false, ourBuyer: false }),
    resolveDealType({ ourListing: true, ourBuyer: true }),
    resolveDealType({ ourListing: true, ourBuyer: false }),
  ]
  check("outputs ⊆ {buyer, seller, dual}", outputs.every((o) => ["buyer", "seller", "dual"].includes(o)))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ DEAL_TYPE_RESOLVER_FAIL"); process.exit(1) }
  console.log(" ✅ DEAL_TYPE_RESOLVER_PASS — buyer / seller / dual from ground truth; single-agent dual covered")
}
main()
