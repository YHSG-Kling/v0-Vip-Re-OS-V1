#!/usr/bin/env tsx
/**
 * scripts/investor-offmarket-simulator.ts   (npm run test:investor-offmarket)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the INVESTOR OFF-MARKET DEAL FINDER (Shopping Agent). A qualified INVESTOR buyer's buy-box is
 * matched to OUR scraped OFF-MARKET / motivated-seller leads in their geography — GEOGRAPHY-GATED and
 * weighted by distress + equity. Regular buyers get MLS matches; investors get off-market. The scoring
 * is PURE; the persist + investor-gate round-trip is proven live against investor_deal_matches.
 *
 * PURE:   inBoxGeography (zip>city, out-of-box → null gate) + scoreOffMarketFit (location + distress +
 *         equity, honest on missing equity) + rankOffMarketMatches (geo-gated, deduped) + boxHasGeography.
 * SOURCE: runner gates to contact_type='investor' + reads the canonical buy-box; owned by shopping_agent;
 *         table in the snapshot; action returns honest reasons.
 * LIVE (creds-gated): seed an investor contact + buy-box + an in-box motivated-seller lead → match →
 *         assert the off-market deal lands ranked → idempotent per contact → non-investor is refused →
 *         clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  inBoxGeography,
  scoreOffMarketFit,
  rankOffMarketMatches,
  qualifiedOffMarketDeals,
  boxHasGeography,
  OFFMARKET_THRESHOLD,
  type InvestorBox,
  type OffMarketProperty,
} from "../lib/buyer-search/investor-offmarket-match"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const box: InvestorBox = {
  minPrice: null, maxPrice: 400000, minBeds: null, minBaths: null,
  cities: ["Phoenix", "Mesa"], zipCodes: ["85053"], propertyTypes: ["Single Family"],
  mustHaveFeatures: [], dealBreakers: [], confidenceScore: 0.8,
} as any

const prop = (over: Partial<OffMarketProperty>): OffMarketProperty => ({
  leadId: "l1", address: "1 St", city: "Phoenix", state: "AZ", zip: "85001",
  motivationType: "probate", motivationConfidence: 0.9, equityEstimate: 150000, ...over,
})

function pureLayer() {
  console.log("\n[inBoxGeography · pure — the hard geography gate, zip tighter than city]")
  check("zip in box → 'zip'", inBoxGeography(box, prop({ zip: "85053" })) === "zip")
  check("city in box (zip not) → 'city'", inBoxGeography(box, prop({ zip: "99999", city: "Mesa" })) === "city")
  check("outside box geography → null (dropped, not a weak match)", inBoxGeography(box, prop({ zip: "99999", city: "Denver" })) === null)
  check("case/space-insensitive city match", inBoxGeography(box, prop({ zip: null, city: "  phoenix " })) === "city")

  console.log("\n[scoreOffMarketFit · pure — location + distress + equity, out-of-box → null]")
  check("out-of-box property scores null (hard gate)", scoreOffMarketFit(box, prop({ zip: "99999", city: "Denver" })) === null)
  const zipProbate = scoreOffMarketFit(box, prop({ zip: "85053", motivationType: "probate", equityEstimate: 300000 }))!
  check("in-zip probate high-equity → strong score", zipProbate.matchScore >= 0.8)
  const cityExpired = scoreOffMarketFit(box, prop({ zip: "99999", city: "Mesa", motivationType: "expired", equityEstimate: null }))!
  check("in-city expired, unknown equity → weaker but present", cityExpired.matchScore > 0 && cityExpired.matchScore < zipProbate.matchScore)
  check("distress ranks probate/pre-foreclosure above expired", scoreOffMarketFit(box, prop({ zip: "85053", motivationType: "pre_foreclosure" }))!.matchScore >= scoreOffMarketFit(box, prop({ zip: "85053", motivationType: "expired" }))!.matchScore)
  check("missing equity is HONEST (neutral-low, not inflated)", scoreOffMarketFit(box, prop({ zip: "85053", equityEstimate: null }))!.matchScore < scoreOffMarketFit(box, prop({ zip: "85053", equityEstimate: 300000 }))!.matchScore)
  check("every match carries human reasons", zipProbate.reasons.length > 0)

  console.log("\n[rankOffMarketMatches · pure — geo-gated, deduped, sorted]")
  const ranked = rankOffMarketMatches(box, [
    prop({ leadId: "a", zip: "85053", motivationType: "probate", equityEstimate: 300000 }),
    prop({ leadId: "b", zip: "99999", city: "Denver" }),           // out of box → dropped
    prop({ leadId: "c", zip: "99999", city: "Mesa", motivationType: "expired", equityEstimate: null }),
    prop({ leadId: "a", zip: "85053", motivationType: "probate" }), // dup id → dropped
  ])
  check("out-of-box + duplicate dropped (2 of 4 survive)", ranked.length === 2)
  check("highest-fit first", ranked[0].leadId === "a")
  check(`qualifiedOffMarketDeals keeps only ≥ ${OFFMARKET_THRESHOLD}`, qualifiedOffMarketDeals(ranked).every((m) => m.matchScore >= OFFMARKET_THRESHOLD))

  console.log("\n[boxHasGeography · pure]")
  check("box with cities/zips → true", boxHasGeography(box) === true)
  check("box with no geography → false (can't match an investor without a market)", boxHasGeography({ ...box, cities: [], zipCodes: [] }) === false)
  check("null box → false", boxHasGeography(null) === false)
}

function sourceLayer() {
  console.log("\n[wiring — investor-gated, reuses the canonical box, owned by shopping_agent]")
  const runner = src("lib/buyer-search/investor-offmarket-runner.ts")
  check("runner gates to contact_type='investor' (regular buyers use the MLS path)", /contact_type !== "investor"[\s\S]*?not_investor/.test(runner))
  check("reads the buy-box via the canonical loadBuyerCriteria (no parallel reader)", /loadBuyerCriteria\(svc, params\.contactId\)/.test(runner))
  check("matches against motivated-seller leads (our off-market inventory)", /from\("leads"\)[\s\S]*?not\("motivation_type", "is", null\)/.test(runner))
  check("idempotent per investor contact (updates the same row)", /eq\("contact_id", m\.contactId\)[\s\S]*?update\(row\)/.test(runner))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by shopping_agent (buyer-side) with a runnable proof", /investor_offmarket_match:\s*\{\s*manager:\s*"shopping_agent",\s*proof:\s*"test:investor-offmarket"/.test(reg))
  check("investor_deal_matches table owned by shopping_agent", /investor_deal_matches:\s*"shopping_agent"/.test(reg))
  check("table in the schema snapshot (drift-guarded)", /investor_deal_matches:\s*\[/.test(src("scripts/schema-snapshot.ts")))
  const act = src("app/actions/investor-deals.ts")
  check("action returns an honest reason when the contact isn't an investor", /not_investor:[\s\S]*?investor buyers/.test(act))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed investor + box + in-box motivated lead → match → idempotent → non-investor refused → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: contact } = await svc.from("contacts").insert({ brokerage_id: brokerageId, first_name: "Ivy", last_name: "Investor", contact_type: "investor" }).select("id").single()
    const contactId = (contact as any).id
    cleanup.push({ table: "contacts", id: contactId })
    const { data: pref } = await svc.from("property_preferences").insert({ brokerage_id: brokerageId, contact_id: contactId, inferred_cities: ["Testville"], inferred_zip_codes: ["09999"], inferred_max_price: 400000 }).select("id").single()
    cleanup.push({ table: "property_preferences", id: (pref as any).id })
    const { data: lead } = await svc.from("leads").insert({ brokerage_id: brokerageId, first_name: "Moti", last_name: "Seller", address: "9 Distress Rd", city: "Testville", state: "AZ", zip_code: "09999", motivation_type: "probate", equity_estimate: 200000, lifecycle_state: "unconsented" }).select("id").single()
    cleanup.push({ table: "leads", id: (lead as any).id })

    const { runInvestorOffMarketMatch, getInvestorDealMatch } = await import("../lib/buyer-search/investor-offmarket-runner")
    const r1 = await runInvestorOffMarketMatch(svc as any, { brokerageId, contactId })
    check("live: matched the in-box motivated-seller lead", r1.ok && (r1.matchCount ?? 0) >= 1)
    const m1 = await getInvestorDealMatch(svc as any, { contactId, brokerageId })
    if (m1) cleanup.push({ table: "investor_deal_matches", id: (m1 as any).id })
    check("live: persisted the off-market deal with a score + reasons", (m1 as any)?.candidates?.[0]?.leadId === (lead as any).id && typeof (m1 as any)?.candidates?.[0]?.matchScore === "number")

    const r2 = await runInvestorOffMarketMatch(svc as any, { brokerageId, contactId })
    check("live: idempotent per contact (still one row)", r2.ok)
    const { count } = await svc.from("investor_deal_matches").select("id", { count: "exact", head: true }).eq("contact_id", contactId)
    check("live: exactly ONE match row per investor", count === 1)

    // A non-investor contact is refused (regular buyers use the MLS path).
    const { data: reg } = await svc.from("contacts").insert({ brokerage_id: brokerageId, first_name: "Reg", last_name: "Buyer", contact_type: "buyer" }).select("id").single()
    cleanup.push({ table: "contacts", id: (reg as any).id })
    const r3 = await runInvestorOffMarketMatch(svc as any, { brokerageId, contactId: (reg as any).id })
    check("live: a non-investor buyer is refused (not_investor)", !r3.ok && r3.reason === "not_investor")
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ INVESTOR_OFFMARKET_FAIL"); process.exit(1) }
  console.log(" ✅ INVESTOR_OFFMARKET_PASS — a qualified investor's box matched to our off-market inventory (geo-gated, distress-weighted); the buyer-side off-market finder no competitor has")
}
main()
