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
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { blankComments } from "./strip-comments"
import { INVESTOR_OFFMARKET_QUICKLISTS, BATCHDATA_QUICKLISTS } from "../lib/external/batchdata-client"
import { normalizeActiveListingSources, DEFAULT_ACTIVE_LISTING_SOURCES, type ActiveListingSource } from "../lib/buyer-search/listing-source-order"
import { toInvestorFacingCandidate, toInvestorFacingCandidates } from "../lib/buyer-search/investor-facing"
import { deriveLikelihoodBand } from "../lib/buyer-search/investor-offmarket-match"

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
  check("every written column has a reader (getInvestorOffMarketCandidates' SELECT names every column the upsert writes, including wave-68's batchrank_score/batchrank_band)",
    ["market_id", "address_key", "property_address", "city", "state", "zip", "quicklists",
     "estimated_value", "equity_percent", "owner_name", "fit_score", "batchrank_score", "batchrank_band",
     "matched_at", "delivered_at", "delivered_via", "dismissed_at"]
      .every((col) => new RegExp(`select\\("[^"]*\\b${col}\\b[^"]*"\\)`).test(runner)))
  check("getInvestorDealMatch (named reader) now carries the BatchData candidates alongside the aggregate match", /rawCandidates = await getInvestorOffMarketCandidates/.test(runner))

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

function ownerRedaction() {
  console.log("\n[OWNER REDACTION — wave 68: \"these investors should not get the owners information\"]")
  // Positive control: a fixture that DOES carry owner_name (and every other owner field the
  // redactor knows about) — proves the finder still recognizes the defect it exists for,
  // rather than reporting a clean bill of health because nothing in the fixture could match.
  const fixture = {
    id: "cand-1", property_address: "9 Distress Rd", city: "Testville", zip: "09999",
    quicklists: ["absentee-owner"], estimated_value: 250000, equity_percent: 40,
    owner_name: "Moti Seller", owner_phone: "+15555551212", owner_email: "moti@example.com",
    owner_mailing_address: "1 Other St, Elsewhere, AZ 00000",
    fit_score: 0.8, matched_at: null, delivered_at: null, delivered_via: null, dismissed_at: null,
  }
  const investorFacing = toInvestorFacingCandidate(fixture) as Record<string, unknown>
  check("audience:\"investor\" (the DEFAULT) strips owner_name from the payload",
    !("owner_name" in investorFacing))
  check("...and every other owner field named in the redactor (phone/email/mailing)",
    !("owner_phone" in investorFacing) && !("owner_email" in investorFacing) && !("owner_mailing_address" in investorFacing))
  check("...and equity_percent — a seller-financial fact, not a property fact (wave 69: \"showing them the properties nothing else\")",
    !("equity_percent" in investorFacing))
  check("...while every NON-owner, non-financial field survives unchanged", investorFacing.property_address === "9 Distress Rd" && investorFacing.fit_score === 0.8)
  // POSITIVE CONTROL (§2): a fixture missing the redaction call entirely (raw passthrough)
  // must still carry equity_percent — proves the check actually exercises the redactor.
  const unredacted = { ...fixture }
  check("positive control: an unredacted row still carries equity_percent (the finder can tell them apart)",
    "equity_percent" in unredacted)

  const brokerageFacing = toInvestorFacingCandidate(fixture, "brokerage") as Record<string, unknown>
  check("audience:\"brokerage\" is an explicit no-op — owner_name is KEPT for the agent surface",
    brokerageFacing.owner_name === "Moti Seller")
  check("...and equity_percent is ALSO kept for the agent surface (brokerage-side needs the seller's financial position)",
    brokerageFacing.equity_percent === 40)

  const arr = toInvestorFacingCandidates([fixture, fixture], "investor")
  check("toInvestorFacingCandidates redacts every row in an array the same way",
    arr.length === 2 && arr.every((r) => !("owner_name" in (r as Record<string, unknown>))))

  console.log("\n[OWNER REDACTION — wiring: the redactor is actually IN the read paths]")
  const runner = stripped("lib/buyer-search/investor-offmarket-runner.ts")
  check("getInvestorDealMatch calls toInvestorFacingCandidates before returning", /toInvestorFacingCandidates\(rawCandidates, audience\)/.test(runner))
  check("...and defaults its own `audience` param to \"investor\" (safe default — nothing can forget)", /audience: CandidateAudience = "investor"/.test(runner))
  const act = stripped("app/actions/investor-deals.ts")
  check("getInvestorDealMatchAction resolves the CALLER'S role before choosing an audience (never trusts a client-supplied flag)", /resolveActorAudience\(userId\)/.test(act))
  check("...via the SAME role predicate every other tenant-admin gate in this repo uses (§6)", /isAgentOrTenantAdmin\(/.test(act))
  const panel = stripped("app/components/contact/investor-deals-panel.tsx")
  check("the panel's client type marks owner_name OPTIONAL, present only for the resolved agent audience", /owner_name\?:\s*string \| null/.test(panel))
}

function investorPortalCardShape() {
  console.log("\n[wave 69 — investor portal card: property-only, likelihood-band proxy]")

  // ── deriveLikelihoodBand · PURE — the proxy table (owner ruling, verbatim, wave 69) ──────
  check("batchrank_band present → authoritative, passed through unchanged (source: batchrank)",
    JSON.stringify(deriveLikelihoodBand(["vacant"], "high")) === JSON.stringify({ band: "high", source: "batchrank" }))
  check("pre-foreclosure → high (signal-based)",
    JSON.stringify(deriveLikelihoodBand(["preforeclosure"], null)) === JSON.stringify({ band: "high", source: "signal-based" }))
  check("tired-landlord → medium (signal-based)",
    JSON.stringify(deriveLikelihoodBand(["tired-landlord"], null)) === JSON.stringify({ band: "medium", source: "signal-based" }))
  check("absentee-owner + high-equity → medium (signal-based)",
    JSON.stringify(deriveLikelihoodBand(["absentee-owner", "high-equity"], null)) === JSON.stringify({ band: "medium", source: "signal-based" }))
  check("absentee-owner ALONE (no high-equity) → NOT medium via that rule (falls to the honest default)",
    deriveLikelihoodBand(["absentee-owner"], null).band === "medium" && deriveLikelihoodBand(["absentee-owner"], null).source === "signal-based")
  check("vacant → low (signal-based)",
    JSON.stringify(deriveLikelihoodBand(["vacant"], null)) === JSON.stringify({ band: "low", source: "signal-based" }))
  check("inherited → low (signal-based)",
    JSON.stringify(deriveLikelihoodBand(["inherited"], null)) === JSON.stringify({ band: "low", source: "signal-based" }))
  check("pre-foreclosure OUTRANKS a co-occurring low-priority tag (priority order, not last-match)",
    deriveLikelihoodBand(["vacant", "preforeclosure"], null).band === "high")
  check("no quicklists and no batchrank → honest medium default, never a fabricated high/low",
    JSON.stringify(deriveLikelihoodBand([], null)) === JSON.stringify({ band: "medium", source: "signal-based" }))
  // POSITIVE CONTROL (§2): mutate the vacant/inherited branch's slugs — the SAME inputs must
  // then fail to reach "low", proving the check actually exercises the mapping, not a tautology.
  const brokenLowRule = (q: string[]) => q.includes("vacant-XXX") || q.includes("inherited-XXX")
  check("positive control: a mutated (wrong-spelled) low-band rule fails on the real 'vacant' input",
    !brokenLowRule(["vacant"]))

  // ── SOURCE — the reader carries the new columns + the derived band, never a spread ────────
  const runner = stripped("lib/buyer-search/investor-offmarket-runner.ts")
  check("getInvestorOffMarketCandidates SELECTs beds/baths/property_type (m644)",
    /select\("[^"]*\bbeds\b[^"]*\bbaths\b[^"]*\bproperty_type\b[^"]*"\)/.test(runner))
  check("every row's likelihood is computed via the ONE pure function (deriveLikelihoodBand), never a second proxy",
    /likelihood:\s*deriveLikelihoodBand\(r\.quicklists,\s*r\.batchrank_band\)/.test(runner))
  check("the upsert WRITES beds/baths/property_type explicitly (not a spread of `r` — wave 67 integration lesson)",
    /beds:\s*r\.beds,\s*baths:\s*r\.baths,\s*property_type:\s*r\.property_type,/.test(runner))
  check("toOffMarketCandidateRow reads beds/baths/property_type off the BatchDataRecord (r.beds/r.baths/r.propertyType)",
    /beds:\s*r\.beds\s*\?\?\s*null,\s*baths:\s*r\.baths\s*\?\?\s*null,\s*property_type:\s*r\.propertyType\s*\?\?\s*null,/.test(runner))

  // ── PORTAL SURFACE — the investor sees property fields ONLY, plus the likelihood badge ────
  const portal = stripped("app/portal/[contactId]/buyer-home.tsx")
  check("investor portal home fetches getInvestorDealMatch ONLY for contact_persona==='investor'",
    /contact\.contact_persona === "investor"[\s\S]{0,200}getInvestorDealMatch/.test(portal))
  check("renders property_address/city/state/zip/estimated_value/beds/baths/property_type",
    ["property_address", "c.city", "c.state", "c.zip", "estimated_value", "c.beds", "c.baths", "c.property_type"]
      .every((tok) => portal.includes(tok)))
  check("renders quicklists and the likelihood band — never owner_name/owner_phone/owner_email/equity_percent literals",
    /c\.quicklists/.test(portal) && /likelihood/.test(portal) &&
    !/c\.owner_name/.test(portal) && !/c\.owner_phone/.test(portal) && !/c\.owner_email/.test(portal) && !/c\.equity_percent/.test(portal))

  // ── MIGRATION — RULE, not a waypoint (§2) ──────────────────────────────────────────────────
  const m644 = raw("supabase/migrations/m644-investor-offmarket-candidates-property-specs.sql")
  const m644Header = m644.split("\n")[2]
  const m644Applied = m644Header.includes("APPLIED LIVE")
  check("m644 header states an honest applied state", m644Applied || m644Header.includes("WRITTEN, NOT APPLIED"))
  check("once m644 is applied the schema snapshot carries investor_offmarket_candidates.beds/baths/property_type",
    !m644Applied || (/investor_offmarket_candidates/.test(raw("scripts/schema-snapshot.ts")) &&
      ["beds", "baths", "property_type"].every((c) => new RegExp(`"${c}"`).test(raw("scripts/schema-snapshot.ts").split("investor_offmarket_candidates")[1]?.slice(0, 800) ?? ""))))
  check("m644 adds beds/baths/property_type as nullable columns (ADD COLUMN IF NOT EXISTS)",
    /ADD COLUMN IF NOT EXISTS beds\s+integer/.test(m644) &&
    /ADD COLUMN IF NOT EXISTS baths\s+numeric/.test(m644) &&
    /ADD COLUMN IF NOT EXISTS property_type text/.test(m644))
  check("likelihood_band is DELIBERATELY not a column (computed pure, documented in the migration's own header)",
    !/ADD COLUMN IF NOT EXISTS likelihood_band/.test(m644) && /DELIBERATELY NOT a column/.test(m644))
}

function dedupeAndTerritory() {
  console.log("\n[dedupe + territory — cross-checked against the live database facts, not just prose]")
  const runner = stripped("lib/buyer-search/investor-offmarket-runner.ts")
  check("dedupe key is address_key, matching normalizeStreetAddress — the SAME address vocabulary the on-market feed uses", /normalizeStreetAddress\(addressRaw\)/.test(runner))
  check("bounded to 2 markets per contact (cost control — never an unbounded territory fan-out)", /\.slice\(0, 2\)/.test(runner))
}

function activeListingSourceOrderWave69() {
  console.log("\n[wave 69 — active-listing source order: IDX-vs-RentCast DERIVED, never a tenant choice]")

  // ── PURE: the resolver's own default + normalization ──────────────────────────────────────
  check("DEFAULT is the single safe fallback [rentcast] — idx is never guessed, batchdata_on_market never assumed on",
    DEFAULT_ACTIVE_LISTING_SOURCES.length === 1 && DEFAULT_ACTIVE_LISTING_SOURCES[0] === "rentcast")
  check("normalizer drops an unknown/junk value and keeps the real ones, in order",
    JSON.stringify(normalizeActiveListingSources(["idx", "bogus", "rentcast", 42, null])) === JSON.stringify(["idx", "rentcast"]))
  check("normalizer dedupes (first occurrence wins)",
    JSON.stringify(normalizeActiveListingSources(["rentcast", "idx", "rentcast"])) === JSON.stringify(["rentcast", "idx"]))
  check("normalizer returns EMPTY on a non-array — no fallback to a non-empty default any more (this column only carries an opt-in flag now)",
    JSON.stringify(normalizeActiveListingSources("not-an-array")) === JSON.stringify([]))
  check("normalizer returns EMPTY when every entry is junk — an empty batchdata_on_market flag is the valid off state, not an error",
    JSON.stringify(normalizeActiveListingSources(["nope", "also-nope"])) === JSON.stringify([]))
  // POSITIVE CONTROL (§2): a raw pass-through (no normalization at all) would NOT match the
  // asserted behavior above — proves the assertion actually exercises filtering, not an identity.
  const identity = (v: unknown) => v as ActiveListingSource[]
  check("positive control: an unfiltered pass-through does NOT equal the normalized result (the finder can tell them apart)",
    JSON.stringify(identity(["idx", "bogus", "rentcast"])) !== JSON.stringify(normalizeActiveListingSources(["idx", "bogus", "rentcast"])))

  // ── RESOLVER: idx-vs-rentcast is DERIVED from the IDX-credential cascade, never stored ──────
  const resolverSrc = stripped("lib/buyer-search/listing-source-order.ts")
  check("resolveActiveListingSources imports resolveRentcastEligibility — the SAME cascade IDXBrokerClient.forBrokerage/test:idx-tenant-credential use",
    /import \{ resolveRentcastEligibility \} from "@\/lib\/property\/rentcast-eligibility"/.test(resolverSrc))
  check("picks \"idx\" when the credential cascade reports connected", /eligibility\.idx\.status === "connected"[\s\S]{0,40}sources = \["idx"\]/.test(resolverSrc))
  check("fails CLOSED to the DEFAULT (never guesses idx) when the credential check is unreadable",
    /eligibility\.idx\.status === "unreadable"[\s\S]{0,260}sources = \[\.\.\.DEFAULT_ACTIVE_LISTING_SOURCES\]/.test(resolverSrc))
  check("falls to \"rentcast\" only when RentCast itself is eligible (platform key + budget)",
    /eligibility\.eligible[\s\S]{0,40}sources = \["rentcast"\]/.test(resolverSrc))
  check("appends batchdata_on_market ONLY from the platform-managed column, never derived",
    /platformSet\.includes\("batchdata_on_market"\)/.test(resolverSrc))
  // POSITIVE CONTROL: the same regex must NOT match a mutated resolver that skips the unreadable
  // fail-closed branch (proves the finder isn't matching on the surrounding scaffolding alone).
  const resolverNoFailClosed = resolverSrc.replace(
    /\} else if \(eligibility\.idx\.status === "unreadable"\) \{[\s\S]{0,260}sources = \[\.\.\.DEFAULT_ACTIVE_LISTING_SOURCES\]\s*\n\s*\}/,
    "}",
  )
  check("positive control: deleting the unreadable fail-closed branch breaks the assertion",
    !/eligibility\.idx\.status === "unreadable"[\s\S]{0,260}sources = \[\.\.\.DEFAULT_ACTIVE_LISTING_SOURCES\]/.test(resolverNoFailClosed))

  // ── SOURCE: every consumer STILL calls the ONE resolver (consumer code untouched this wave) ─
  const mw = stripped("lib/buyer-search/market-watch.ts")
  check("market-watch.ts imports the ONE resolver (no second reader of the setting)",
    /import \{ resolveActiveListingSources \} from "\.\/listing-source-order"/.test(mw))
  const mwGateRe = /const sources = await resolveActiveListingSources\(brokerageId\)[\s\S]*?if \(sources\.includes\("batchdata_on_market"\)\)/
  check("runMarketWatchForBuyer gates the market_active_listings pull on the resolved order", mwGateRe.test(mw))
  const mwMutated = mw.replace('if (sources.includes("batchdata_on_market")) {', 'if (sources.includes("nonexistent_source")) {')
  check("positive control: mutating the gated source name breaks the same assertion", !mwGateRe.test(mwMutated))

  const em = stripped("lib/buyer-search/external-match.ts")
  check("external-match.ts imports the SAME resolver (one vocabulary, §6)",
    /import \{ resolveActiveListingSources \} from "\.\/listing-source-order"/.test(em))
  check("runExternalMarketWatchForBuyer no-ops when BOTH idx and rentcast are absent from the derived order",
    /if \(!sources\.includes\("idx"\) && !sources\.includes\("rentcast"\)\)/.test(em))

  const feed = stripped("lib/kernel/listings-batchdata-feed.ts")
  check("listings-batchdata-feed.ts imports the SAME resolver",
    /import \{ resolveActiveListingSources \} from "@\/lib\/buyer-search\/listing-source-order"/.test(feed))
  check("runActiveListingDiscoveryForMarket SKIPS the billed pull when batchdata_on_market is excluded",
    /const sources = await resolveActiveListingSources\(market\.brokerage_id\)[\s\S]{0,120}if \(!sources\.includes\("batchdata_on_market"\)\)[\s\S]{0,120}return \{ observed: 0, transitions: 0, signalsWritten: 0, errors: \[\] \}/.test(feed))

  // ── SETTINGS SURFACE — tenant page has NO source checklist, mounts the IDX form ONLY ────────
  check("the wave-68 tenant write seam is DELETED", !existsSync(join(process.cwd(), "app/actions/settings/active-listing-sources.ts")))
  const leadSourcesClient = stripped("app/dashboard/settings/integrations/lead-sources/lead-sources-client.tsx")
  check("the tenant settings page carries NO ordered-checklist vocabulary any more",
    !/SOURCE_INFO/.test(leadSourcesClient) && !/updateActiveListingSourcesSetting/.test(leadSourcesClient) && !/ActiveListingSourcesCard/.test(leadSourcesClient))
  check("...and mounts the EXISTING IDX Broker form (reused, never a second one)",
    /import IDXBrokerSettingsPage from "@\/app\/dashboard\/settings\/integrations\/idx-broker\/page"/.test(leadSourcesClient) && /<IDXBrokerSettingsPage \/>/.test(leadSourcesClient))
  const leadSourcesPage = stripped("app/dashboard/settings/integrations/lead-sources/page.tsx")
  check("the page no longer reads/writes the tenant-facing listing-sources action",
    !/active-listing-sources/.test(leadSourcesPage))

  // ── PLATFORM-STAFF-ONLY WRITER for the one thing still stored: batchdata_on_market ──────────
  const superadminAction = stripped("app/actions/superadmin/active-listing-sources.ts")
  check("the read AND the write both gate on requireSuperadmin (platform cost lever, never a tenant one)",
    (superadminAction.match(/const auth = await requireSuperadmin\(\)/g) ?? []).length >= 2)
  check("the writer normalizes before persisting (never stores a value the resolver would refuse)",
    /const normalized = normalizeActiveListingSources\(params\.sources\)/.test(superadminAction))
  const superadminPanel = stripped("app/dashboard/superadmin/brokerages/[id]/listing-sources-panel.tsx")
  check("a superadmin control calls the platform-staff writer",
    /setBrokerageActiveListingSourcesAction/.test(superadminPanel))
  const brokerageDetailPage = stripped("app/dashboard/superadmin/brokerages/[id]/page.tsx")
  check("the superadmin tenant-detail page mounts the panel",
    /<ListingSourcesPanel brokerageId={brokerage\.id} \/>/.test(brokerageDetailPage))

  // ── FEED PANEL ───────────────────────────────────────────────────────────────────────────────
  const actions = stripped("app/actions/lead-scraping-config.ts")
  check("getBatchDataFeedStatus resolves activeListingSources via the ONE resolver",
    /const activeListingSources = brokerageId\s*\n\s*\? await resolveActiveListingSources\(brokerageId\)/.test(actions))
  check("getBatchDataFeedStatus's success return carries activeListingSources",
    (actions.match(/activeListingSources,?/g) ?? []).length >= 3) // resolve line + success return + error-path fallback
  const panel = stripped("app/dashboard/admin/markets/markets-client.tsx")
  check("admin markets panel's disabled note no longer implies a tenant setting page controls this",
    !/Settings → Lead Sources/.test(panel) && /platform-cost decision/.test(panel))

  // ── MIGRATION SHAPE — RULE, not a waypoint (§2): honest state, never pinned to one literal ──
  const migration642 = raw("supabase/migrations/m642-active-listing-source-order.sql")
  const m642Header = migration642.split("\n")[2]
  const m642Applied = m642Header.includes("APPLIED LIVE")
  check("m642 header states an honest applied state", m642Applied || m642Header.includes("WRITTEN, NOT APPLIED"))
  check("once m642 is applied the schema snapshot carries brokerage_settings.active_listing_sources",
    !m642Applied || /active_listing_sources/.test(raw("scripts/schema-snapshot.ts")))

  const migration643 = raw("supabase/migrations/m643-active-listing-sources-platform-managed.sql")
  const m643Header = migration643.split("\n")[2]
  check("m643 header states an honest state (written-pending or applied-live), never a pinned waypoint",
    m643Header.includes("WRITTEN, NOT APPLIED") || m643Header.includes("APPLIED LIVE"))
  check("m643 narrows the column's comment to PLATFORM-STAFF-MANAGED",
    /PLATFORM-STAFF-MANAGED/.test(migration643))
  check("m643 drops the DEFAULT to an empty array (idx/rentcast are no longer stored values)",
    /ALTER COLUMN active_listing_sources SET DEFAULT '\[\]'::jsonb/.test(migration643))
  // POSITIVE CONTROL: the same regex must not match m642's unrelated default clause.
  check("positive control: m642's OWN default clause (a different shape) does not satisfy the m643 assertion",
    !/ALTER COLUMN active_listing_sources SET DEFAULT '\[\]'::jsonb/.test(migration642))

  // ── MANAGER REGISTRY ────────────────────────────────────────────────────────────────────────
  const registry = stripped("lib/kernel/manager-registry.ts")
  check("registered in MAINTENANCE_DOMAINS, owned by shopping_agent (the buyer-market-watch owner)",
    /active_listing_source_order:\s*\{\s*manager:\s*"shopping_agent"/.test(registry))
  check("the registry entry describes DERIVATION, not a stored tenant ranking",
    /active_listing_source_order:[\s\S]{0,2000}DERIVED/.test(registry))
}

/**
 * WAVE 70 — LISTING ATTRIBUTION SURFACE WIRING.
 *
 * Owner, verbatim: "the settings page needs to not say otherwise platforms
 * rentcast feed just platform feed but rentcast i know legally when we
 * display a listing it must say provided from rentcast, etc."
 *
 * lib/listings/attribution.ts::listingAttributionLine + <ListingAttribution />
 * is the ONE shared helper/component (§6 — one vocabulary). This does not
 * re-derive the wording (that is comp-adjustments-simulator's and
 * cma-provider-lane-simulator's job on the CMA side); it proves every named
 * DISPLAY surface actually IMPORTS the shared helper or component rather than
 * rolling its own — the defect this whole capability replaces (buyer-home.tsx
 * used to print the raw `source` string next to the price with no attribution
 * sentence at all).
 */
function listingAttributionWiring() {
  console.log("\n[wave 70 · every RentCast-fed display surface imports the SHARED attribution helper]")

  const HELPER_IMPORT = /from ["']@\/lib\/listings\/attribution["']/
  const COMPONENT_IMPORT = /from ["']@\/app\/components\/listings\/ListingAttribution["']/

  const surfaces: Array<{ file: string; pattern: RegExp; label: string }> = [
    { file: "app/components/forms/SmartSearchWidget.tsx", pattern: COMPONENT_IMPORT, label: "buyer portal smart-search widget" },
    { file: "app/portal/[contactId]/buyer-home.tsx", pattern: COMPONENT_IMPORT, label: "buyer-home saved homes" },
    { file: "app/actions/buyer-portal-matches.ts", pattern: HELPER_IMPORT, label: "Top Matches panel's data action" },
    { file: "lib/agents/buyer-match-reel-producer.ts", pattern: HELPER_IMPORT, label: "buyer-match reel payload" },
    { file: "app/dashboard/listings/[id]/cma/tabs/cma-report-tab.tsx", pattern: COMPONENT_IMPORT, label: "CMA comp table" },
  ]

  for (const s of surfaces) {
    const exists = existsSync(join(process.cwd(), s.file))
    check(
      `${s.label} (${s.file}) imports the shared attribution ${s.pattern === HELPER_IMPORT ? "helper" : "component"}`,
      exists && s.pattern.test(raw(s.file)),
    )
  }

  // TopMatchesPanel doesn't import the helper itself — it renders the
  // ALREADY-COMPUTED `m.attribution` string the action above builds (one
  // computation, not a second one in the presentational component). Assert
  // that binding instead of a (wrong) import requirement.
  check(
    "TopMatchesPanel (app/portal/[contactId]/components/TopMatchesPanel.tsx) renders the pre-computed m.attribution",
    existsSync(join(process.cwd(), "app/portal/[contactId]/components/TopMatchesPanel.tsx")) &&
      /\{m\.attribution/.test(raw("app/portal/[contactId]/components/TopMatchesPanel.tsx")),
  )

  // portal-cards.ts doesn't import the helper either — it is the PURE MAPPER
  // that used to DROP `source` on the floor between the search engine and the
  // widget (a RentCast-fed result rendered with no attribution at all). Assert
  // the structural fix: `source` is read from the input and written onto the card.
  const cards = raw("lib/buyer-search/portal-cards.ts")
  check(
    "portal-cards.ts (the pure mapper) now carries `source` through instead of dropping it",
    /if \(r\.source\) card\.source = r\.source/.test(cards),
  )

  // POSITIVE CONTROL — a fixture file's content missing the import must make
  // the SAME regex predicate report false, proving the check discriminates.
  {
    const fixtureWithout = `import { Button } from "@/app/components/ui/button"\nexport function X() { return null }`
    check(
      "positive control: the component-import check correctly fails on a fixture missing the import",
      !COMPONENT_IMPORT.test(fixtureWithout),
    )
    check(
      "positive control: the helper-import check correctly fails on a fixture missing the import",
      !HELPER_IMPORT.test(fixtureWithout),
    )
  }
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
  ownerRedaction()
  investorPortalCardShape()
  dedupeAndTerritory()
  activeListingSourceOrderWave69()
  listingAttributionWiring()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ BUYER_MATCHING_RAILS_FAIL"); process.exit(1) }
  console.log(" ✅ BUYER_MATCHING_RAILS_PASS — investor-intent contacts get off-market BatchData candidates only, regular buyers get active-for-sale listings only, never crossed, contact-only, territory-bound")
}
main()
