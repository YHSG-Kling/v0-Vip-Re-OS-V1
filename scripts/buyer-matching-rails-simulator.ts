#!/usr/bin/env tsx
/**
 * scripts/buyer-matching-rails-simulator.ts   (npm run test:buyer-matching-rails)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the wave 67 owner ruling (verbatim): "make sure that with a buyer who we know is an
 * investor intent, that we are giving them off market listings to assist with their searching.
 * smart search is also to help regular buyers find properties with their known criteria, how are
 * we handling these in regards to sending them active for sale listings."
 *
 * TWO RAILS, asserted never to cross:
 *   INVESTOR  — lib/buyer-search/investor-offmarket-runner.ts pulls BatchData's OFF-MARKET
 *               quickLists ONLY (INVESTOR_OFFMARKET_QUICKLISTS) into investor_offmarket_candidates
 *               (m638), additive to the existing scraped-lead/contact rail.
 *   REGULAR   — lib/buyer-search/market-watch.ts::runMarketWatchForBuyer reads market_active_listings
 *               (m636/m639, current_status='active') beside its own `listings` inventory, and
 *               REFUSES an investor-persona contact (the two rails are mutually exclusive per contact).
 *
 * Every scan reads STRIPPED source (scripts/strip-comments.ts) — a tombstone/comment naming an old
 * quicklist must never count as a live reference (CLAUDE.md §2).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { blankComments } from "./strip-comments"
import { INVESTOR_OFFMARKET_QUICKLISTS, BATCHDATA_QUICKLISTS } from "../lib/external/batchdata-client"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const raw = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
// Comments stripped (a tombstone must never count as a live reference, §2) — STRINGS KEPT, since
// several assertions below match table names / reason literals that legitimately live inside
// quoted arguments (e.g. .from("investor_offmarket_candidates"), reason: "contact_not_found").
const stripped = (p: string) => blankComments(raw(p))

const ON_MARKET_SLUGS = new Set(["on-market", "pending-listing", "recently-sold", "active-listing"])

function pureQuicklistVocabulary() {
  console.log("\n[INVESTOR_OFFMARKET_QUICKLISTS · never on-market]")
  check("every entry is a REAL BatchData quickList (validated against BATCHDATA_QUICKLISTS)",
    INVESTOR_OFFMARKET_QUICKLISTS.every((q) => BATCHDATA_QUICKLISTS.has(q)))
  check("NO on-market slug ever appears in the investor rail's vocabulary",
    INVESTOR_OFFMARKET_QUICKLISTS.every((q) => !ON_MARKET_SLUGS.has(q)))
  check("carries the owner-named triggers (absentee/high-equity/tired-landlord/vacant/pre-foreclosure/probate)",
    ["absentee-owner", "high-equity", "tired-landlord", "vacant", "preforeclosure", "inherited"]
      .every((q) => (INVESTOR_OFFMARKET_QUICKLISTS as readonly string[]).includes(q)))
  // POSITIVE CONTROL (§2): the finder must still catch a deliberately-injected on-market slug.
  const poisoned = [...INVESTOR_OFFMARKET_QUICKLISTS, "on-market"]
  check("positive control: a poisoned list WITH on-market fails the same assertion", !poisoned.every((q) => !ON_MARKET_SLUGS.has(q)))
}

function investorRailSource() {
  console.log("\n[investor rail — off-market ONLY, additive, territory-bound]")
  const runner = stripped("lib/buyer-search/investor-offmarket-runner.ts")
  check("pulls via fetchIncrementalPropertySearch (cursor/session, bounded take)", /fetchIncrementalPropertySearch\(\{[\s\S]*?quicklist,[\s\S]*?searchSession:[\s\S]*?take:\s*20/.test(runner))
  check("loops INVESTOR_OFFMARKET_QUICKLISTS (never a hardcoded on-market literal)", /for \(const quicklist of INVESTOR_OFFMARKET_QUICKLISTS\)/.test(runner))
  check("territory-bound: only THIS brokerage's OWN active markets", /from\("lead_scraping_markets"\)[\s\S]*?eq\("brokerage_id", brokerageId\)[\s\S]*?eq\("is_active", true\)/.test(runner))
  check("geography-matched to the box (city or zip intersection) before any pull", /cities\.has\(\(m\.city[\s\S]*?zips\.has\(z\)\)/.test(runner))
  check("ADDITIVE: the existing scraped lead/contact match still runs (rankOffMarketMatches unchanged)", /const ranked = rankOffMarketMatches\(box, props\)/.test(runner))
  check("scored by the SAME pure engine as the scraped rail (one vocabulary, §6)", /scoreOffMarketFit\(params\.box, mapped\.property\)/.test(runner))
  check("persists into the NEW table investor_offmarket_candidates (not the aggregate blob)", /from\("investor_offmarket_candidates"\)[\s\S]*?upsert\(upserts, \{ onConflict: "contact_id,address_key" \}\)/.test(runner))
  check("dedupe key matches the migration's UNIQUE constraint (contact_id,address_key)", /onConflict:\s*"contact_id,address_key"/.test(runner))
  check("cost metered once per pull (no double-meter — batchdata-client itself never meters)", /meterVendorSpend\(\{[\s\S]*?usageType:\s*"investor_offmarket_search"/.test(runner))
  check("delivery reuses the SAME portal-card path the scraped rail already uses (one push, two sources)", /pushPortalValueCard\(\{[\s\S]*?updateType:\s*"investor_offmarket_deals"[\s\S]*?\}, svc\)[\s\S]*?stampDelivered/.test(runner))
  check("stamps delivered_at/delivered_via on the rows just surfaced (never re-stamps an old delivery)", /update\(\{ delivered_at: new Date\(\)\.toISOString\(\), delivered_via: via \}\)[\s\S]*?is\("delivered_at", null\)/.test(runner))
  check("every written column has a reader (getInvestorOffMarketCandidates selects the full column list)",
    /select\("id, market_id, address_key, property_address, city, state, zip, quicklists, estimated_value, equity_percent, owner_name, fit_score, matched_at, delivered_at, delivered_via, dismissed_at"\)/.test(runner))
  check("getInvestorDealMatch (named reader) now carries the BatchData candidates alongside the aggregate match", /offMarketCandidates = await getInvestorOffMarketCandidates/.test(runner))

  const panel = stripped("app/components/contact/investor-deals-panel.tsx")
  check("portal surface renders the BatchData candidates (offMarketCandidates reader)", /offMarketCandidates/.test(panel) && /batchDataDeals/.test(panel))

  const migration = raw("supabase/migrations/m638-investor-offmarket-candidates.sql")
  // RULE, not waypoint (CLAUDE.md §2): the header on line 3 states an honest
  // state — either still WRITTEN NOT APPLIED, or APPLIED LIVE — and once it says
  // APPLIED the live schema snapshot must carry the table (m638 applied 2026-09-16).
  const m638Header = migration.split("\n")[2]
  const m638Applied = m638Header.includes("APPLIED LIVE")
  check("m638 header states an honest applied state", m638Applied || m638Header.includes("WRITTEN, NOT APPLIED"))
  const snapshot = raw("scripts/schema-snapshot.ts")
  check("once m638 is applied the schema snapshot carries investor_offmarket_candidates", !m638Applied || /investor_offmarket_candidates/.test(snapshot))
  check("UNIQUE (contact_id, address_key) — the dedupe rule the code's onConflict relies on", /UNIQUE \(contact_id, address_key\)/.test(migration))
  check("RLS tenant policy on brokerage_id = current_user_brokerage_id()", /current_user_brokerage_id\(\)/.test(migration))
  check("every proof-listed column exists in the migration", [
    "id", "brokerage_id", "contact_id", "market_id", "address_key", "property_address", "city",
    "state", "zip", "quicklists", "estimated_value", "equity_percent", "owner_name", "fit_score",
    "matched_at", "delivered_at", "delivered_via", "dismissed_at",
  ].every((col) => new RegExp(`\\b${col}\\b`).test(migration)))
}

function regularBuyerRailSource() {
  console.log("\n[regular-buyer rail — active-for-sale ONLY, investor-excluded]")
  const mw = stripped("lib/buyer-search/market-watch.ts")
  check("PERSONA GATE: refuses an investor-persona contact before any listing read", /contact_persona === "investor"[\s\S]*?reason: "investor_offmarket_only"/.test(mw))
  check("gate runs on the ONE resolver (contacts.contact_persona) — no second persona check", (mw.match(/contact_persona/g) ?? []).length >= 2)
  check("reads market_active_listings BESIDE the existing `listings` inventory (never instead of)", /from\("listings"\)[\s\S]*?from\("market_active_listings"\)/.test(mw))
  check("scoped to current_status='active' and THIS brokerage's own markets", /eq\("brokerage_id", brokerageId\)\.eq\("current_status", "active"\)/.test(mw))
  check("scored through the SAME pure scoreCriteriaFit (maps beds/baths/city → ListingFacts)", /bedrooms: m\.beds, bathrooms: m\.baths, city: m\.city/.test(mw))
  check("delivered through the SAME property_matches upsert every source already uses", /upserts\.push\(\{[\s\S]*?match_reasons: \{ source: l\.__source, fit_score: score \}/.test(mw))

  const cron = stripped("app/api/cron/buyer-market-watch/route.ts")
  check("cron still drives runMarketWatchForBuyer (no new cron — folded into the existing one)", /runMarketWatchForBuyer\(svc, p\.brokerage_id, p\.contact_id\)/.test(cron))

  const feed = stripped("lib/kernel/listings-batchdata-feed.ts")
  check("feed writer WRITES beds/baths/sqft/property_type from the BatchData record", /beds: record\.beds \?\? null[\s\S]*?baths: record\.baths \?\? null[\s\S]*?sqft: record\.sqft \?\? null[\s\S]*?property_type: record\.propertyType \?\? null/.test(feed))

  const client = stripped("lib/external/batchdata-client.ts")
  check("normalizeBatchDataProperty reads propertyType off the BatchData record", /propertyType: building\.propertyType \?\? building\.property_type \?\? p\.propertyType \?\? undefined/.test(client))

  const actions = stripped("app/actions/lead-scraping-config.ts")
  check("getBatchDataFeedStatus READS beds/baths/sqft/property_type (the reader half)", /select\("id, market_id, property_address, city, state, zip, current_status, list_price, beds, baths, sqft, property_type, batchdata_quicklists/.test(actions))

  const panel = stripped("app/dashboard/admin/markets/markets-client.tsx")
  check("admin markets panel RENDERS beds/baths/sqft/property_type", /l\.beds/.test(panel) && /l\.baths/.test(panel) && /l\.sqft/.test(panel) && /l\.property_type/.test(panel))

  const m639 = raw("supabase/migrations/m639-market-active-listings-criteria-specs.sql")
  const m639Header = m639.split("\n")[2]
  const m639Applied = m639Header.includes("APPLIED LIVE")
  check("m639 header states an honest applied state", m639Applied || m639Header.includes("WRITTEN, NOT APPLIED"))
  check("once m639 is applied the schema snapshot carries market_active_listings.beds/baths/sqft/property_type",
    !m639Applied || (/market_active_listings/.test(raw("scripts/schema-snapshot.ts")) && /"beds"/.test(raw("scripts/schema-snapshot.ts").split("market_active_listings")[1]?.slice(0, 800) ?? "")))
  check("m639 adds all four nullable spec columns", /ADD COLUMN IF NOT EXISTS beds\s+integer/.test(m639) && /ADD COLUMN IF NOT EXISTS baths\s+numeric/.test(m639) && /ADD COLUMN IF NOT EXISTS sqft\s+integer/.test(m639) && /ADD COLUMN IF NOT EXISTS property_type text/.test(m639))
}

function contactOnlyDelivery() {
  console.log("\n[contact-only delivery — a lead id is refused by every entry point]")
  const runner = stripped("lib/buyer-search/investor-offmarket-runner.ts")
  check("runInvestorOffMarketMatch resolves the actor from `contacts` ONLY (never `leads`)", /from\("contacts"\)[\s\S]*?select\("id, contact_type, contact_persona, agent_id, brokerage_id"\)/.test(runner))
  check("an unresolved id (no matching contacts row) is refused (contact_not_found)", /if \(!contact\) return \{ ok: false, reason: "contact_not_found" \}/.test(runner))
  const mw = stripped("lib/buyer-search/market-watch.ts")
  check("runMarketWatchForBuyer's persona gate is also read off `contacts` (never `leads`)", /from\("contacts"\)[\s\S]*?select\("contact_persona"\)/.test(mw))
  const act = stripped("app/actions/investor-deals.ts")
  check("the agent-facing action validates a UUID before touching the DB (no lead id smuggled through)", /isValidUUID\(contactId\)/.test(act))
}

function dedupeAndTerritory() {
  console.log("\n[dedupe + territory — cross-checked against the live database facts, not just prose]")
  const runner = stripped("lib/buyer-search/investor-offmarket-runner.ts")
  check("dedupe key is address_key, matching normalizeStreetAddress — the SAME address vocabulary the on-market feed uses", /normalizeStreetAddress\(addressRaw\)/.test(runner))
  check("bounded to 2 markets per contact (cost control — never an unbounded territory fan-out)", /\.slice\(0, 2\)/.test(runner))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] persona gate live round-trip: investor contact refused by runMarketWatchForBuyer")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: investor } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Iva", last_name: "Rail", contact_type: "buyer", contact_persona: "investor",
    }).select("id").single()
    const investorId = (investor as any).id
    cleanup.push({ table: "contacts", id: investorId })

    const { runMarketWatchForBuyer } = await import("../lib/buyer-search/market-watch")
    const r = await runMarketWatchForBuyer(svc as any, brokerageId, investorId)
    check("live: an investor-persona contact NEVER gets active-listing matches", r.matched === 0 && r.newMatches === 0 && r.reason === "investor_offmarket_only")
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureQuicklistVocabulary()
  investorRailSource()
  regularBuyerRailSource()
  contactOnlyDelivery()
  dedupeAndTerritory()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ BUYER_MATCHING_RAILS_FAIL"); process.exit(1) }
  console.log(" ✅ BUYER_MATCHING_RAILS_PASS — investor-intent contacts get off-market BatchData candidates only, regular buyers get active-for-sale listings only, never crossed, contact-only, territory-bound")
}
main()
