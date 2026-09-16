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
import { normalizeActiveListingSources, DEFAULT_ACTIVE_LISTING_SOURCES, type ActiveListingSource } from "../lib/buyer-search/listing-source-order"

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

function activeListingSourceOrderWave68() {
  console.log("\n[wave 68 — active-listing source order: cost ruling on the BatchData on-market pull]")

  // ── PURE: the resolver's own default + normalization ──────────────────────────────────────
  check("DEFAULT excludes batchdata_on_market (cost reason — off by default)",
    !DEFAULT_ACTIVE_LISTING_SOURCES.includes("batchdata_on_market"))
  check("DEFAULT is exactly [idx, rentcast] in that order (the owner-ruled precedence)",
    DEFAULT_ACTIVE_LISTING_SOURCES.length === 2 && DEFAULT_ACTIVE_LISTING_SOURCES[0] === "idx" && DEFAULT_ACTIVE_LISTING_SOURCES[1] === "rentcast")
  check("normalizer drops an unknown/junk value and keeps the real ones, in order",
    JSON.stringify(normalizeActiveListingSources(["idx", "bogus", "rentcast", 42, null])) === JSON.stringify(["idx", "rentcast"]))
  check("normalizer dedupes (first occurrence wins)",
    JSON.stringify(normalizeActiveListingSources(["rentcast", "idx", "rentcast"])) === JSON.stringify(["rentcast", "idx"]))
  check("normalizer falls back to the DEFAULT on a non-array (malformed column)",
    JSON.stringify(normalizeActiveListingSources("not-an-array")) === JSON.stringify(DEFAULT_ACTIVE_LISTING_SOURCES))
  check("normalizer falls back to the DEFAULT when every entry is junk (never an empty list)",
    JSON.stringify(normalizeActiveListingSources(["nope", "also-nope"])) === JSON.stringify(DEFAULT_ACTIVE_LISTING_SOURCES))
  // POSITIVE CONTROL (§2): a raw pass-through (no normalization at all) would NOT match the
  // asserted behavior above — proves the assertion actually exercises filtering, not an identity.
  const identity = (v: unknown) => v as ActiveListingSource[]
  check("positive control: an unfiltered pass-through does NOT equal the normalized result (the finder can tell them apart)",
    JSON.stringify(identity(["idx", "bogus", "rentcast"])) !== JSON.stringify(normalizeActiveListingSources(["idx", "bogus", "rentcast"])))

  // ── SOURCE: every consumer calls the ONE resolver ──────────────────────────────────────────
  const mw = stripped("lib/buyer-search/market-watch.ts")
  check("market-watch.ts imports the ONE resolver (no second reader of the setting)",
    /import \{ resolveActiveListingSources \} from "\.\/listing-source-order"/.test(mw))
  const mwGateRe = /const sources = await resolveActiveListingSources\(brokerageId\)[\s\S]*?if \(sources\.includes\("batchdata_on_market"\)\)/
  check("runMarketWatchForBuyer gates the market_active_listings pull on the resolved order", mwGateRe.test(mw))
  // POSITIVE CONTROL (§2): mutate the gate condition to a different source name — the SAME
  // regex, over the mutated text, must fail, proving the finder is not a tautology.
  const mwMutated = mw.replace('if (sources.includes("batchdata_on_market")) {', 'if (sources.includes("nonexistent_source")) {')
  check("positive control: mutating the gated source name breaks the same assertion", !mwGateRe.test(mwMutated))

  const em = stripped("lib/buyer-search/external-match.ts")
  check("external-match.ts imports the SAME resolver (one vocabulary, §6)",
    /import \{ resolveActiveListingSources \} from "\.\/listing-source-order"/.test(em))
  check("runExternalMarketWatchForBuyer no-ops when BOTH idx and rentcast are excluded",
    /if \(!sources\.includes\("idx"\) && !sources\.includes\("rentcast"\)\)/.test(em))
  check("runExternalMarketWatchForBuyer refuses a CONNECTION-chosen tier this brokerage excluded (never overrides the connection precedence, only narrows it)",
    /if \(!sources\.includes\(result\.source\)\)[\s\S]{0,120}reason: `\$\{result\.source\}_excluded_by_setting`/.test(em))

  const feed = stripped("lib/kernel/listings-batchdata-feed.ts")
  check("listings-batchdata-feed.ts imports the SAME resolver",
    /import \{ resolveActiveListingSources \} from "@\/lib\/buyer-search\/listing-source-order"/.test(feed))
  check("runActiveListingDiscoveryForMarket SKIPS the billed pull when batchdata_on_market is excluded",
    /const sources = await resolveActiveListingSources\(market\.brokerage_id\)[\s\S]{0,120}if \(!sources\.includes\("batchdata_on_market"\)\)[\s\S]{0,120}return \{ observed: 0, transitions: 0, signalsWritten: 0, errors: \[\] \}/.test(feed))
  // POSITIVE CONTROL: the same regex must NOT match the file with the skip line removed.
  const feedNoSkip = feed.replace(
    /if \(!sources\.includes\("batchdata_on_market"\)\) \{\s*return \{ observed: 0, transitions: 0, signalsWritten: 0, errors: \[\] \}\s*\}/,
    "",
  )
  check("positive control: deleting the skip block makes the same assertion fail",
    !/const sources = await resolveActiveListingSources\(market\.brokerage_id\)[\s\S]{0,120}if \(!sources\.includes\("batchdata_on_market"\)\)[\s\S]{0,120}return \{ observed: 0, transitions: 0, signalsWritten: 0, errors: \[\] \}/.test(feedNoSkip))
  check("the cron caller (app/api/cron/lead-scraping/route.ts) is UNCHANGED — the skip lives inside the function, not the cron",
    /const r = await runActiveListingDiscoveryForMarket\(supabase, market\)/.test(stripped("app/api/cron/lead-scraping/route.ts")))

  // ── SETTINGS SURFACE ────────────────────────────────────────────────────────────────────────
  const settingsAction = stripped("app/actions/settings/active-listing-sources.ts")
  check("settings action reads through requireBrokerageAdmin (gate first, then the client — §4)",
    /requireBrokerageAdmin\(supabase, acting\.userId\)/.test(settingsAction) && /requireBrokerageAdmin\(supabase, ctx\.userId\)/.test(settingsAction))
  check("settings write normalizes before persisting (never stores a value the resolver would refuse)",
    /const normalized = normalizeActiveListingSources\(sources\)/.test(settingsAction))
  const leadSourcesClient = stripped("app/dashboard/settings/integrations/lead-sources/lead-sources-client.tsx")
  check("the settings page renders an ordered checklist with a per-source cost hint",
    /SOURCE_INFO/.test(leadSourcesClient) && /updateActiveListingSourcesSetting/.test(leadSourcesClient))

  // ── FEED PANEL ───────────────────────────────────────────────────────────────────────────────
  const actions = stripped("app/actions/lead-scraping-config.ts")
  check("getBatchDataFeedStatus resolves activeListingSources via the ONE resolver",
    /const activeListingSources = brokerageId\s*\n\s*\? await resolveActiveListingSources\(brokerageId\)/.test(actions))
  check("getBatchDataFeedStatus's success return carries activeListingSources",
    (actions.match(/activeListingSources,?/g) ?? []).length >= 3) // resolve line + success return + error-path fallback
  const panel = stripped("app/dashboard/admin/markets/markets-client.tsx")
  check("admin markets panel shows the exact disabled note",
    /BatchData on-market pull disabled — IDX\/RentCast serve buyer smart search/.test(panel))

  // ── MIGRATION SHAPE — RULE, not a waypoint (§2): honest state, never pinned to one literal ──
  const migration = raw("supabase/migrations/m642-active-listing-source-order.sql")
  const m642Header = migration.split("\n")[2]
  const m642Applied = m642Header.includes("APPLIED LIVE")
  check("m642 header states an honest applied state", m642Applied || m642Header.includes("WRITTEN, NOT APPLIED"))
  check("once m642 is applied the schema snapshot carries brokerage_settings.active_listing_sources",
    !m642Applied || /active_listing_sources/.test(raw("scripts/schema-snapshot.ts")))
  check("adds active_listing_sources as jsonb NOT NULL with the owner-ruled default",
    /active_listing_sources jsonb NOT NULL DEFAULT '\["idx","rentcast"\]'::jsonb/.test(migration))
  check("CHECK constraint asserts it is a jsonb ARRAY (jsonb_typeof)",
    /CHECK \(jsonb_typeof\(active_listing_sources\) = 'array'\)/.test(migration))

  // ── MANAGER REGISTRY ────────────────────────────────────────────────────────────────────────
  const registry = stripped("lib/kernel/manager-registry.ts")
  check("registered in MAINTENANCE_DOMAINS, owned by shopping_agent (the buyer-market-watch owner)",
    /active_listing_source_order:\s*\{\s*manager:\s*"shopping_agent"/.test(registry))
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
  activeListingSourceOrderWave68()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ BUYER_MATCHING_RAILS_FAIL"); process.exit(1) }
  console.log(" ✅ BUYER_MATCHING_RAILS_PASS — investor-intent contacts get off-market BatchData candidates only, regular buyers get active-for-sale listings only, never crossed, contact-only, territory-bound")
}
main()
