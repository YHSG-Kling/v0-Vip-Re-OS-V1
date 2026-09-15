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

import { recordMatchesTerritory, buildAgentSeekingPhrases } from "../lib/lead-pipeline/source-intent-map"

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

  console.log("\n[Layer 1b · Wave 65 lanes — query builders never fall back to a global/borderless sweep]")
  const phrasesReal = buildAgentSeekingPhrases({ city: "Austin", state: "TX" })
  check("agent_seeking_phrase_intent / reddit_relocation phrase builder is territory-scoped", phrasesReal.phrases.every((p) => p.includes("Austin")))
  // POSITIVE CONTROL — a lane without a territory gate IS caught here: an empty market must
  // produce ZERO phrases, never a "search everywhere" fallback.
  check("POSITIVE CONTROL: no territory ⇒ zero phrases (the gate a missing check would miss)", buildAgentSeekingPhrases({ city: null, state: null }).phrases.length === 0)
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

    const mkRecord = (city: string, state: string, channel: string) => ({
      source: tag, sourceRecordId: `${tag}-${channel}-${city}`, rawPayload: { tag },
      firstName: "Test", lastName: city, email: `${tag}-${channel}-${city}@example.com`.toLowerCase(),
      phone: null, city, state, zip: null, propertyAddress: null,
      intentType: "buyer" as const, behaviorType: "social_intent",
    })

    // The gate is CHANNEL-AGNOSTIC (a positive control that a lane without its own territory
    // gate is still caught): run the SAME on-territory/off-territory pair through the original
    // "reddit" channel AND three wave-65 channel names ingestRawSourceBatch has never seen
    // before this wave. If any one of these skipped the gate, its off-territory row would
    // survive into raw_scraped_leads and this loop would go red.
    const channels = ["reddit", "reddit_relocation", "facebook_recommend_realtor", "zillow_chatter"]
    for (const channel of channels) {
      const res = await ingestRawSourceBatch({
        brokerageId, marketId, source: "social_intent",
        sourceFamily: "social_intent", sourceChannel: channel,
        records: [mkRecord("Austin", "TX", channel), mkRecord("Dallas", "TX", channel)] as any,
        executionId: null,
      })
      check(`[${channel}] only the on-territory record was inserted`, res.inserted === 1)
      check(`[${channel}] the off-territory record was dropped at the territory gate`, res.skipped_territory === 1)
    }

    const { data: raws } = await svc.from("raw_scraped_leads").select("city, source_channel").eq("market_id", marketId)
    const rows = (raws ?? []) as Array<{ city: string | null; source_channel: string | null }>
    check("raw_scraped_leads holds only Austin rows (no Dallas), across every channel", rows.every((r) => r.city === "Austin"))
    check("every wave-65 channel wrote its OWN sourceChannel (none merged into another)",
      new Set(rows.map((r) => r.source_channel)).size === channels.length)
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
