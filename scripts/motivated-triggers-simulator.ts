#!/usr/bin/env tsx
/**
 * scripts/motivated-triggers-simulator.ts   (npm run test:motivated-triggers)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves motivated-seller scrapes (probate, foreclosure, tax_lien, divorce-attempt, …) resolve
 * to BATCHDATA triggers FIRST. batchDataTriggersFor maps a market's configured signal types to the
 * real BatchData quickList triggers, pulled trigger-by-trigger — so a market that configures
 * probate/tax_lien actually PULLS them from BatchData (previously only the trio was pulled and the
 * rest were filtered-but-never-scraped). Types BatchData can't serve (divorce/bankruptcy/eviction)
 * are dropped (they come from OSINT). No config → the cost-safe high-intent trio. Pure.
 */
import { batchDataTriggersFor, BATCHDATA_MOTIVATION_TYPES } from "../lib/external/batchdata-client"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const eq = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",")

function main() {
  console.log("\n[configured motivated-seller types → BatchData triggers]")
  check("probate is pulled from BatchData", batchDataTriggersFor(["probate"]).includes("probate"))
  check("foreclosure + tax_lien pulled from BatchData", eq(batchDataTriggersFor(["foreclosure", "tax_lien"]), ["foreclosure", "tax_lien"]))
  check("the full supported taxonomy resolves (probate/foreclosure/pre_foreclosure/tax_lien/high_equity/absentee/vacant/tired_landlord)",
    eq(batchDataTriggersFor(["probate", "foreclosure", "pre_foreclosure", "tax_lien", "high_equity", "absentee", "vacant", "tired_landlord"]),
       ["probate", "foreclosure", "pre_foreclosure", "tax_lien", "high_equity", "absentee", "vacant", "tired_landlord"]))

  console.log("\n[aliases the DB/config might store]")
  check("'preforeclosure' → pre_foreclosure", batchDataTriggersFor(["preforeclosure"]).includes("pre_foreclosure"))
  check("'tax-lien' → tax_lien", batchDataTriggersFor(["tax-lien"]).includes("tax_lien"))
  check("'inherited' → probate", batchDataTriggersFor(["inherited"]).includes("probate"))
  check("'Tired Landlord' (spaces/case) → tired_landlord", batchDataTriggersFor(["Tired Landlord"]).includes("tired_landlord"))

  console.log("\n[types BatchData can't serve are dropped (OSINT covers them)]")
  check("divorce is NOT a BatchData trigger (comes from OSINT)", !batchDataTriggersFor(["divorce"]).includes("divorce"))
  check("bankruptcy/eviction dropped", batchDataTriggersFor(["bankruptcy", "eviction"]).length === 3 /* falls back to trio, none supported */)
  check("mixed config keeps only the BatchData-serveable ones", eq(batchDataTriggersFor(["probate", "divorce", "tax_lien", "bankruptcy"]), ["probate", "tax_lien"]))

  console.log("\n[defaults + guards]")
  check("no config → the high-intent trio", eq(batchDataTriggersFor([]), ["high_equity", "pre_foreclosure", "absentee"]))
  check("null → the trio", eq(batchDataTriggersFor(null), ["high_equity", "pre_foreclosure", "absentee"]))
  check("'expired' excluded here (pulled on its own gated path)", !batchDataTriggersFor(["expired", "probate"]).includes("expired"))
  check("duplicates collapse", eq(batchDataTriggersFor(["probate", "probate", "inherited"]), ["probate"]))
  check("BATCHDATA_MOTIVATION_TYPES includes probate/foreclosure/tax_lien/vacant/tired_landlord", ["probate", "foreclosure", "tax_lien", "vacant", "tired_landlord"].every((t) => (BATCHDATA_MOTIVATION_TYPES as readonly string[]).includes(t)))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MOTIVATED_TRIGGERS_FAIL"); process.exit(1) }
  console.log(" ✅ MOTIVATED_TRIGGERS_PASS — probate/foreclosure/tax_lien/etc. are scraped from BatchData first; divorce/bankruptcy fall to OSINT")
}
main()
