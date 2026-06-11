#!/usr/bin/env tsx
/**
 * scripts/area-query-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * "ANYTHING HAPPENING NEAR 44 BIRCH?" harness — the bullpen for a PLACE.
 *
 * Layer 1 (pure): resolveAreaName (a matching address → its city; else the bare
 *   query); composeAreaAnswer (manager-attributed; honest when nothing's running).
 * Layer 2 (live, gated): seed two active listings in a city + a promo reel + a live
 *   ad targeting that city; run runAreaQuery via a street address; assert Listing
 *   Concierge counts the inventory, Asset Manager reports the reel, Ads Manager
 *   reports the live campaign, and an empty area answers honestly. Self-cleans.
 *
 * Run: npx tsx scripts/area-query-simulator.ts  (npm run test:area-query)
 */
import { resolveAreaName, composeAreaAnswer, runAreaQuery } from "../lib/kernel/area-query"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Area query (the bullpen for a place) verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Area query simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · resolve + compose]")
  const listings = [{ address: "44 Birch Lane", city: "Oakdale" }, { address: "9 Elm St", city: "Springfield" }]
  check("'44 Birch' → its city (Oakdale)", resolveAreaName(listings, "44 Birch") === "Oakdale")
  check("bare place name passes through ('Springfield')", resolveAreaName(listings, "Springfield") === "Springfield")
  check("no address match → the query itself", resolveAreaName(listings, "Westview") === "Westview")
  const ans = composeAreaAnswer("Oakdale", [
    { manager: "listing_concierge", line: "we have 2 active listings in Oakdale on the board." },
    { manager: "ads_manager", line: "1 paid campaign is live targeting Oakdale right now." },
  ])
  check("answer: manager-attributed", ans.includes("Listing Concierge:") && ans.includes("Ads Manager:"))
  check("empty area: honest + offers to start a campaign", composeAreaAnswer("Nowhere", []).includes("Nothing's running in Nowhere"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live area]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Area${Date.now()}`
  const CITY = `${TAG}ville`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentUserId = (agent as any).user_id

    const { data: l1 } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 44 Birch Lane`, city: CITY, status: "active",
    }).select("id").single()
    cleanup.push({ table: "listings", id: (l1 as any).id })
    const { data: l2 } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 88 Cedar Ct`, city: CITY, status: "active",
    }).select("id").single()
    cleanup.push({ table: "listings", id: (l2 as any).id })
    const { data: promo } = await svc.from("listing_promo_videos").insert({
      brokerage_id: brokerageId, listing_id: (l1 as any).id, agent_id: agentUserId,
      event_type: "just_listed", status: "social_drafted",
    }).select("id").single()
    cleanup.push({ table: "listing_promo_videos", id: (promo as any).id })
    const { data: ad } = await svc.from("ad_campaigns").insert({
      brokerage_id: brokerageId, campaign_name: `${TAG} Coverage`, platform: "facebook",
      status: "live", objective: "lead_generation", targeting_config: { locations: [CITY] },
    }).select("id").single()
    cleanup.push({ table: "ad_campaigns", id: (ad as any).id })

    // Ask via the street address — it must resolve to CITY and report all three benches.
    const a = await runAreaQuery(brokerageId, `${TAG} 44 Birch`, svc)
    check("area resolved from the address to its city", a.area === CITY)
    const managers = new Set(a.contributions.map((x) => x.manager))
    check("Listing Concierge counted the 2 active listings", a.spoken.includes("2 active listings"))
    check("Asset Manager reported the ready reel", managers.has("asset_manager") && a.spoken.includes("ready to share"))
    check("Ads Manager reported the live campaign targeting the area", managers.has("ads_manager") && a.spoken.includes("live targeting"))

    // An empty area answers honestly.
    const empty = await runAreaQuery(brokerageId, "Nonexistentburg", svc)
    check("empty area → honest, no fabricated activity", empty.contributions.length === 0 && empty.spoken.includes("Nothing's running"))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("listings").select("id", { count: "exact", head: true }).eq("city", CITY)
    check("cleanup verified — 0 seeded listings remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
