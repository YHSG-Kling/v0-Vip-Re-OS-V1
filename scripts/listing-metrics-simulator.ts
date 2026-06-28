#!/usr/bin/env tsx
/**
 * scripts/listing-metrics-simulator.ts   (npm run test:listing-metrics)
 * ─────────────────────────────────────────────────────────────────────────────
 * LISTING-METRICS ROLLUP — proves the pure shaping that drives the missing listing_metrics writer:
 * the market-start date anchor (so DOM is correct) and the property_views summation. The DB
 * aggregation + upsert is proven by the live round-trip in the PR (seed sources → rollup-equivalent
 * SQL → reads non-zero → cleanup == 0). Pure layer: no I/O.
 */
import { pickMarketStartDate, sumViewCounts } from "../lib/listings/listing-metrics-shape"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  const NOW = new Date("2026-06-28T12:00:00Z")

  console.log("\n[Market-start date anchor — DOM reads the earliest metric date as 'hit the market']")
  check("prefers go_live_date", pickMarketStartDate({ go_live_date: "2026-01-15", listing_date: "2026-02-01", created_at: "2026-03-01T00:00:00Z" }, NOW) === "2026-01-15")
  check("falls back to listing_date when no go-live", pickMarketStartDate({ go_live_date: null, listing_date: "2026-02-01", created_at: "2026-03-01" }, NOW) === "2026-02-01")
  check("falls back to created_at when neither", pickMarketStartDate({ go_live_date: null, listing_date: null, created_at: "2026-03-01T09:30:00Z" }, NOW) === "2026-03-01")
  check("final fallback is now() (never null/empty)", pickMarketStartDate({}, NOW) === "2026-06-28")
  check("normalizes a full timestamp to YYYY-MM-DD", pickMarketStartDate({ go_live_date: "2026-04-05T23:59:59Z" }, NOW) === "2026-04-05")

  console.log("\n[property_views summation — null-safe]")
  check("sums per-row view_count", sumViewCounts([{ view_count: 3 }, { view_count: 7 }, { view_count: 2 }]) === 12)
  check("treats null/undefined counts as 0", sumViewCounts([{ view_count: 5 }, { view_count: null }, {}]) === 5)
  check("empty/null input → 0", sumViewCounts([]) === 0 && sumViewCounts(null) === 0 && sumViewCounts(undefined) === 0)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LISTING_METRICS_FAIL"); process.exit(1) }
  console.log(" ✅ LISTING_METRICS_PASS — the rollup anchors DOM correctly and sums views safely")
}

main()
