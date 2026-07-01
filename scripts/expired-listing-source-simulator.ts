#!/usr/bin/env tsx
/**
 * scripts/expired-listing-source-simulator.ts   (npm run test:expired-listing-source)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves expired listings are sourced from BATCHDATA (the 'expired' motivation trigger →
 * quickList 'expired-listing'), not scraped from portal HTML. normalizeBatchDataRecord now
 * tags a BatchData record labeled 'expired' (or carrying an expired/canceled/failed listing
 * quickList) as the expired_listing source, while the motivated-seller trio stays generic.
 * Also asserts the source map points expired_listing at the batchdata scraper. Pure.
 */
import { normalizeBatchDataRecord } from "../lib/lead-pipeline/scraper-parsers"
import { SOURCE_VENDOR } from "../lib/lead-pipeline/source-intent-map"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const MARKET = { city: "Austin", state: "TX", zip_codes: [] as string[] }
const norm = (r: Record<string, unknown>) => normalizeBatchDataRecord(r, MARKET as any)

function main() {
  console.log("\n[source map]")
  check("expired_listing is sourced from the batchdata scraper (not zenrows)", SOURCE_VENDOR.expired_listing === "batchdata")

  console.log("\n[BatchData 'expired' motivation → expired_listing lead]")
  const expired = norm({ motivationType: "expired", firstName: "Dana", lastName: "Poe", propertyAddress: "9 Elm St", phone: "5125550100" })
  check("source = expired_listing", expired.source === "expired_listing")
  check("behaviorType = expired_listing", expired.behaviorType === "expired_listing")
  check("intent stays seller", expired.intentType === "seller")
  check("intentSignals = ['expired_listing']", JSON.stringify(expired.intentSignals) === JSON.stringify(["expired_listing"]))

  console.log("\n[quickList fallback — expired/canceled/failed listing tags also count]")
  check("quickList 'expired-listing' (no motivationType) → expired", norm({ quickLists: ["high-equity", "expired-listing"], firstName: "A", lastName: "B" }).source === "expired_listing")
  check("quickList 'canceled-listing' → expired", norm({ quickLists: ["canceled-listing"], firstName: "A", lastName: "B" }).source === "expired_listing")
  check("quickList 'failed-listing' → expired", norm({ quickLists: ["failed-listing"], firstName: "A", lastName: "B" }).source === "expired_listing")

  console.log("\n[the motivated-seller trio is NOT mis-tagged as expired]")
  for (const m of ["high_equity", "pre_foreclosure", "absentee"]) {
    const r = norm({ motivationType: m, firstName: "A", lastName: "B" })
    check(`${m} → source batchdata_motivated`, r.source === "batchdata_motivated" && r.behaviorType === "motivated_seller")
    check(`${m} → intentSignals = [${m}]`, JSON.stringify(r.intentSignals) === JSON.stringify([m]))
  }
  check("absentee-owner quickList (not a listing tag) → NOT expired", norm({ motivationType: "absentee", quickLists: ["absentee-owner"], firstName: "A", lastName: "B" }).source === "batchdata_motivated")

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ EXPIRED_LISTING_SOURCE_FAIL"); process.exit(1) }
  console.log(" ✅ EXPIRED_LISTING_SOURCE_PASS — expired listings come from BatchData, tagged expired_listing; trio unaffected")
}
main()
