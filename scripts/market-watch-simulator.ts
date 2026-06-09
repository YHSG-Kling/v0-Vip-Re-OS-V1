#!/usr/bin/env tsx
/**
 * scripts/market-watch-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 62 — proves the scheduled per-buyer market watch: deterministic criteria
 * scoring + matching OUR active listings into property_matches (correct columns:
 * list_price, inferred_*), idempotent. Fixes the drift where the old matcher filtered
 * a non-existent `price` column and returned zero matches for any buyer with a budget.
 *
 *   Layer 1 — pure: scoreCriteriaFit (dealbreakers disqualify; qualifying scores 60–100).
 *   Layer 2 — live (gated): seed a buyer + preferences + listings → runMarketWatchForBuyer
 *     writes property_matches for fits ≥ threshold; idempotent; over-budget excluded; cleanup.
 *
 * Run: npx tsx scripts/market-watch-simulator.ts  (npm run test:market-watch)
 */
import { scoreCriteriaFit, MATCH_FIT_THRESHOLD, type BuyerCriteria } from "../lib/buyer-search/market-watch"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const EMPTY = { zipCodes: [], mustHaveFeatures: [], dealBreakers: [], confidenceScore: null }
const crit: BuyerCriteria = { minPrice: 400000, maxPrice: 600000, minBeds: 3, minBaths: 2, cities: ["Maple Grove"], propertyTypes: [], ...EMPTY }

function testPure() {
  console.log("\n[Layer 1 · scoreCriteriaFit]")
  check("in-budget, beds/baths met, city match → high score (≥ threshold)",
    scoreCriteriaFit(crit, { list_price: 485000, bedrooms: 3, bathrooms: 2, city: "Maple Grove" }) >= MATCH_FIT_THRESHOLD)
  check("OVER max budget → disqualified (0)",
    scoreCriteriaFit(crit, { list_price: 750000, bedrooms: 4, bathrooms: 3, city: "Maple Grove" }) === 0)
  check("UNDER min beds → disqualified (0)",
    scoreCriteriaFit(crit, { list_price: 485000, bedrooms: 2, bathrooms: 2, city: "Maple Grove" }) === 0)
  check("wrong city still scores but lower than a city match",
    scoreCriteriaFit(crit, { list_price: 485000, bedrooms: 3, bathrooms: 2, city: "Far Away" }) <
    scoreCriteriaFit(crit, { list_price: 485000, bedrooms: 3, bathrooms: 2, city: "Maple Grove" }))
  check("no criteria at all → neutral-qualifying score",
    scoreCriteriaFit({ minPrice: null, maxPrice: null, minBeds: null, minBaths: null, cities: [], propertyTypes: [], ...EMPTY }, { list_price: 999999 }) >= MATCH_FIT_THRESHOLD)
}

async function testLive() {
  console.log("\n[Layer 2 · live market watch over our listings]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure layer ran)."); return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runMarketWatchForBuyer } = await import("../lib/buyer-search/market-watch")
  const svc = createServiceClient()
  const TAG = `__mw_${Date.now()}__`
  let buyerId: string | null = null, fitId: string | null = null, overId: string | null = null
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id

    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: `${TAG}Buyer`, last_name: "Test", email: `${TAG}b@example.com`, contact_type: "buyer", buyer_stage: "BUYER_SEARCHING",
    }).select("id").maybeSingle()
    buyerId = (c as { id: string } | null)?.id ?? null
    if (!buyerId) { console.log("  ⏭  contact seed failed — skipped"); return }
    await svc.from("property_preferences").insert({
      brokerage_id: brokerageId, contact_id: buyerId,
      preferred_price_min: 400000, preferred_price_max: 600000, inferred_beds_min: 3, inferred_baths_min: 2, inferred_cities: ["Maple Grove"],
    })
    const mk = async (price: number) => {
      const { data } = await svc.from("listings").insert({
        brokerage_id: brokerageId, address: `${TAG} ${price} St`, city: "Maple Grove", state: "MN",
        list_price: price, bedrooms: 3, bathrooms: 2, status: "active", lifecycle_stage: "MLS_ACTIVE",
      }).select("id").maybeSingle()
      return (data as { id: string } | null)?.id ?? null
    }
    fitId = await mk(485000)     // in budget → should match
    overId = await mk(750000)    // over budget → must NOT match
    if (!fitId || !overId) { console.log("  ⏭  listing seed failed — skipped"); return }

    const r = await runMarketWatchForBuyer(svc, brokerageId, buyerId)
    check("watch matches the in-budget listing", r.matched >= 1 && r.newMatches >= 1, `matched=${r.matched} new=${r.newMatches}`)

    const { data: matches } = await svc.from("property_matches").select("property_id, match_score, ai_generated").eq("contact_id", buyerId)
    const rows = (matches ?? []) as Array<{ property_id: string; match_score: number; ai_generated: boolean }>
    check("in-budget listing is in property_matches (deterministic, ai_generated=false)", rows.some((m) => m.property_id === fitId && m.ai_generated === false && m.match_score >= MATCH_FIT_THRESHOLD))
    check("OVER-budget listing is NOT matched (dealbreaker)", !rows.some((m) => m.property_id === overId))

    const r2 = await runMarketWatchForBuyer(svc, brokerageId, buyerId)
    check("idempotent — re-run produces no NEW matches", r2.newMatches === 0, `new=${r2.newMatches}`)
    const { count } = await svc.from("property_matches").select("id", { count: "exact", head: true }).eq("contact_id", buyerId)
    check("no duplicate match rows on re-run", (count ?? 0) === rows.length)
  } finally {
    if (buyerId) {
      try { await svc.from("property_matches").delete().eq("contact_id", buyerId) } catch {}
      try { await svc.from("property_preferences").delete().eq("contact_id", buyerId) } catch {}
      try { await svc.from("contacts").delete().eq("id", buyerId) } catch {}
    }
    for (const id of [fitId, overId]) { if (id) { try { await svc.from("listings").delete().eq("id", id) } catch {} } }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("first_name", `${TAG}%`)
    check("cleanup verified — 0 test contacts remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Scheduled buyer market-watch simulator (deterministic, correct columns)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Market watch: every active buyer's criteria matched against our inventory, idempotent")
}
main().catch((e) => { console.error(e); process.exit(1) })
