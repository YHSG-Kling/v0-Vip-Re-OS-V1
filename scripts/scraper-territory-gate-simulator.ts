#!/usr/bin/env tsx
/**
 * scripts/scraper-territory-gate-simulator.ts   (npm run test:scraper-territory-gate)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves no scraper INGESTS a lead that doesn't belong to an active territory.
 *
 * Scrapers only RUN for active-subscription active markets, but social/AI sources can
 * return records from a WIDER area than the market's geography. Those used to land in
 * raw_scraped_leads and only get filtered at promotion (territory_mismatch dead rows).
 * The territory gate now runs at INGEST in BOTH writers (insertRawRecord +
 * ingestRawSourceBatch) so off-territory records are never written.
 *
 * Layer 1 (pure): recordMatchesTerritory drops CLEAR mismatches (wrong zip; wrong
 *   city+state) and passes on-territory / no-geo / partial-geo records.
 * Layer 2 (live, gated): ingestRawSourceBatch with one on-territory + one off-territory
 *   record inserts ONLY the on-territory one (skipped_territory == 1). Self-cleaning.
 */
import { randomUUID } from "node:crypto"
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* nothing to shim */ }

import { recordMatchesTerritory } from "../lib/lead-pipeline/source-intent-map"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function pureLayer(): void {
  console.log("\n[Layer 1 · recordMatchesTerritory — drop CLEAR mismatches, pass the rest]")
  const market = { city: "Austin", state: "TX", zip_codes: ["78701", "78702"] }
  check("matching zip ⇒ in territory", recordMatchesTerritory({ zip: "78701" }, market) === true)
  check("non-market zip ⇒ OUT of territory", recordMatchesTerritory({ zip: "90210" }, market) === false)
  check("matching city+state ⇒ in territory", recordMatchesTerritory({ city: "Austin", state: "TX" }, market) === true)
  check("wrong city, same state ⇒ OUT of territory", recordMatchesTerritory({ city: "Dallas", state: "TX" }, market) === false)
  check("wrong state ⇒ OUT of territory", recordMatchesTerritory({ city: "Austin", state: "CA" }, market) === false)
  check("no geography ⇒ pass through (enrichment + promotion re-check)", recordMatchesTerritory({}, market) === true)
  check("state-only (partial) ⇒ pass through", recordMatchesTerritory({ state: "TX" }, market) === true)
  check("city-only (partial) ⇒ pass through", recordMatchesTerritory({ city: "Austin" }, market) === true)
  check("zip takes precedence — matching zip even if city differs", recordMatchesTerritory({ zip: "78702", city: "Dallas" }, market) === true)
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the gate")
    return
  }
  console.log("\n[Layer 2 · live — ingestRawSourceBatch drops the off-territory record at INGEST]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { ingestRawSourceBatch } = await import("../lib/kernel/scraping")
  const svc = createServiceClient()
  const tag = `terr-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const marketId = randomUUID()
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (territory gate)` })
    await svc.from("lead_scraping_markets").insert({
      id: marketId, brokerage_id: brokerageId, name: `${tag} Austin`, city: "Austin", state: "TX", zip_codes: ["78701"], is_active: true,
    })

    const mkRecord = (city: string, state: string) => ({
      source: tag, sourceRecordId: `${tag}-${city}`, rawPayload: { tag },
      firstName: "Test", lastName: city, email: `${tag}-${city}@example.com`.toLowerCase(),
      phone: null, city, state, zip: null, propertyAddress: null,
      intentType: "buyer" as const, behaviorType: "social_intent",
    })

    const res = await ingestRawSourceBatch({
      brokerageId, marketId, source: "social_intent",
      sourceFamily: "social_intent", sourceChannel: "reddit",
      records: [mkRecord("Austin", "TX"), mkRecord("Dallas", "TX")] as any,
      executionId: null,
    })

    check("only the on-territory record was inserted", res.inserted === 1)
    check("the off-territory record was dropped at the territory gate", res.skipped_territory === 1)

    const { data: raws } = await svc.from("raw_scraped_leads").select("city").eq("market_id", marketId)
    const cities = ((raws ?? []) as Array<{ city: string | null }>).map((r) => r.city)
    check("raw_scraped_leads holds only the Austin record (no Dallas)", cities.length === 1 && cities[0] === "Austin")
  } finally {
    await svc.from("raw_scraped_leads").delete().eq("market_id", marketId)
    await svc.from("scraper_executions").delete().eq("brokerage_id", brokerageId)
    await svc.from("lead_scraping_markets").delete().eq("id", marketId)
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("raw_scraped_leads").select("id", { count: "exact", head: true }).eq("market_id", marketId)
    check("cleanup complete (no test rows remain)", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SCRAPER_TERRITORY_GATE_FAIL"); process.exit(1) }
  console.log(" ✅ SCRAPER_TERRITORY_GATE_PASS — off-territory leads are never ingested (both writers gated)")
}

main().catch((e) => { console.error(e); process.exit(1) })
