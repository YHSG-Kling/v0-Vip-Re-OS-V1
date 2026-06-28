#!/usr/bin/env tsx
/**
 * scripts/back-on-market-simulator.ts   (npm run test:back-on-market)
 * ─────────────────────────────────────────────────────────────────────────────
 * BACK ON MARKET — proves the detector fires ONLY when a listing returns to active FROM a contract
 * stage (deal fell through), and NEVER on a normal first go-live — so the Shopping Agent re-engages
 * the saved-home buyers at the right moment without mis-firing on every launch. Pure: no I/O.
 */
import { isBackOnMarket } from "../lib/listings/back-on-market"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Back on market — a contract stage returns to active]")
  check("UNDER_CONTRACT → MLS_ACTIVE → back on market", isBackOnMarket("UNDER_CONTRACT", "MLS_ACTIVE") === true)
  check("INSPECTION → SHOWINGS_ACTIVE → back on market", isBackOnMarket("INSPECTION", "SHOWINGS_ACTIVE") === true)
  check("FINANCING → ACTIVE → back on market", isBackOnMarket("FINANCING", "ACTIVE") === true)
  check("NEGOTIATION → MLS_ACTIVE → back on market", isBackOnMarket("NEGOTIATION", "MLS_ACTIVE") === true)
  check("case-insensitive (under_contract → mls_active)", isBackOnMarket("under_contract", "mls_active") === true)

  console.log("\n[NOT back on market — never mis-fire on a normal launch]")
  check("first go-live COMING_SOON_ACTIVE → MLS_ACTIVE → NO", isBackOnMarket("COMING_SOON_ACTIVE", "MLS_ACTIVE") === false)
  check("MLS_READY → MLS_ACTIVE (normal) → NO", isBackOnMarket("MLS_READY", "MLS_ACTIVE") === false)
  check("active → UNDER_CONTRACT (going under contract) → NO", isBackOnMarket("MLS_ACTIVE", "UNDER_CONTRACT") === false)
  check("UNDER_CONTRACT → CLOSED → NO (closed, not back on market)", isBackOnMarket("UNDER_CONTRACT", "CLOSED") === false)
  check("null stages → NO", isBackOnMarket(null, "MLS_ACTIVE") === false && isBackOnMarket("UNDER_CONTRACT", null) === false)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ BACK_ON_MARKET_FAIL"); process.exit(1) }
  console.log(" ✅ BACK_ON_MARKET_PASS — re-engages saved-home buyers when a deal falls through, never on a normal launch")
}

main()
