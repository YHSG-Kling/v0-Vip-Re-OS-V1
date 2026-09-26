/**
 * scripts/acquisition-coverage-guard.ts — `npm run test:acquisition-coverage`
 *
 * LANE 82B (wave 82, 2026-09-25 — scraping UNFROZEN). Owner verbatim: "make sure we have covered
 * every area of lead acquisition and enrichment scraping opportunities for our os… the lead
 * scraping/intelligence/properties is a linear setup. we scrape, then dedup against any current raw
 * lead, lead or contact, run enrichment, then do another dedup, run through gate for
 * territory/identity to convert raw to a lead… where they came from for lead cost tracking… these
 * scrape searching should be territory centric… These are platform-paid."
 *
 * For EVERY SourceKey (derived from source-intent-map.ts::ALL_SOURCE_KEYS — never a hand list) it
 * proves, with no network:
 *   L1  coverage — a SOURCE_ACQUISITION entry (intents + entry door); every one of the five owner
 *       populations (sell / buy / relocate / realtor_seeking / investor) has ≥2 wired sources.
 *   L2  TERRITORY-SCOPED — the entry door resolves active-subscriber territories BEFORE it scrapes
 *       (cron: the gate token sits INSIDE the resolved-markets loop).
 *   L3  LINEAR PIPELINE — the source's records reach the ONE raw writer (ingestRawSourceBatch) and
 *       the ONE processor whose order is territory gate → dedup → enrich → dedup → identity gate → lead.
 *   L4  PLATFORM LEDGER — its spend books on vendor_usage_tracking under the SOURCE_VENDOR vendor,
 *       usage_type = SourceKey (source-cost-ledger.ts::bookSourceSpend → meterVendorSpend); the
 *       composite "apify_social" row is gone.
 *   L5  COST PER RECORD — the write carries a non-null batch cost (→ raw_scraped_leads.cost_per_record).
 *   L6  SCHEDULED — its door is on the cron dispatcher (or is an event-driven webhook/mailbox door).
 *   L7  AUTONOMY + NO COMPLIANCE GATE ON ACQUISITION.
 *   L8  the lane-82B builds (Marketplace, BatchData triggers, SOURCE_VENDOR / PAID_ONLY_ANSWERS /
 *       VALID_AGENT_TYPES runtime readers) + registration.
 *   L9  lane 83A (wave 83) — the OWNER'S intents per source (OWNER_REQUIRED_INTENTS: site chatter
 *       sells; Marketplace buys / relocates / seeks a realtor, and still sells) are DECLARED and
 *       PRODUCED by the source's own parser on a fixture (recordAcquisitionIntents — rule-derived);
 *       the TikTok lane (two Apify hops, territory-scoped, booked per source).
 * Every absence assertion carries a POSITIVE CONTROL fixture (CLAUDE.md §2).
 */
import { readFileSync, existsSync } from "fs"
import { stripComments, blankStrings } from "./strip-comments"
import {
  ALL_SOURCE_KEYS, SOURCE_VENDOR, expandEnabledSources, vendorForSource, resolveSourceKey, type SourceKey,
} from "../lib/lead-pipeline/source-intent-map"
import { SOURCE_ACQUISITION, acquisitionIntentLabel, OWNER_REQUIRED_INTENTS, recordAcquisitionIntents, type AcquisitionIntent } from "../lib/lead-pipeline/acquisition-coverage"
import { parseSellerChatter, parseContactAgentChatter } from "../lib/lead-pipeline/scraper-parsers"
import { sourceTikTokIntent, normalizeTikTokComment } from "../lib/lead-pipeline/social-sourcer"
import { DEFAULT_SCRAPE_KEYWORDS } from "../lib/lead-pipeline/scrape-keywords"
import { planSourceSpendBooking, bookSourceSpend, leadCostBySource } from "../lib/lead-pipeline/source-cost-ledger"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"
import { normalizeFacebookMarketplaceListing, sourceFacebookMarketplace } from "../lib/lead-pipeline/social-sourcer"
import { ACTOR_REGISTRY } from "../lib/external/apify-actors"
import { batchDataTriggersFor, quickListSlugsFor, BATCHDATA_QUICKLISTS, BATCHDATA_MOTIVATION_TYPES } from "../lib/external/batchdata-client"
import { planEnrichmentLane, PAID_ONLY_ANSWERS, FREE_OSINT_ANSWERS } from "../lib/external/osint-free"
import { canonicalAgentType, getAgentDisplayName, getAgentConfig, VALID_AGENT_TYPES } from "../lib/intelligence/agent-registry"

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
const stripped = (p: string) => stripComments(read(p))
const code = (p: string) => blankStrings(stripped(p))

const ROUTE = "app/api/cron/lead-scraping/route.ts"
const route = stripped(ROUTE)
const INTENTS: AcquisitionIntent[] = ["sell", "buy", "relocate", "realtor_seeking", "investor"]
const KEYS = ALL_SOURCE_KEYS as SourceKey[]
const PAID = (k: SourceKey) => SOURCE_VENDOR[k] !== "internal"
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// ── L0 · scanner positive control ────────────────────────────────────────────
console.log("\n[L0 · scanner — a tombstone is not a call site]")
check("POSITIVE CONTROL: stripComments removes a comment naming `enabledSources.has(\"x\")` and keeps live code",
  !/enabledSources/.test(stripComments(`// enabledSources.has("x") was here\nconst a = 1`)) && /const a = 1/.test(stripComments(`// x\nconst a = 1`)))

// ── L1 · coverage matrix ─────────────────────────────────────────────────────
console.log("\n[L1 · coverage — every SourceKey declares its populations + door]")
const registryKeys = Object.keys(SOURCE_ACQUISITION).sort()
check(`SOURCE_ACQUISITION covers exactly ALL_SOURCE_KEYS (${KEYS.length} keys, derived)`,
  registryKeys.length === KEYS.length && KEYS.every((k) => k in SOURCE_ACQUISITION), `${registryKeys.length} vs ${KEYS.length}`)
check("every SourceKey names ≥1 population", KEYS.every((k) => SOURCE_ACQUISITION[k].intents.length > 0))
const byIntent = new Map<AcquisitionIntent, SourceKey[]>(INTENTS.map((i) => [i, KEYS.filter((k) => SOURCE_ACQUISITION[k].intents.includes(i))]))
for (const i of INTENTS) check(`population "${i}" has ≥2 wired sources (${byIntent.get(i)!.length}: ${byIntent.get(i)!.join(", ")})`, byIntent.get(i)!.length >= 2)
check("POSITIVE CONTROL: an intent nobody declares reads as uncovered", KEYS.filter((k) => (SOURCE_ACQUISITION[k].intents as readonly string[]).includes("time_travel")).length === 0)
// Lane 83A — the label is DERIVED from the registry (was pinned to Marketplace's old "sellers" — a waypoint).
check("runtime reader: acquisitionIntentLabel renders the populations (markets panel)",
  acquisitionIntentLabel("facebook_marketplace").split(" · ").length === SOURCE_ACQUISITION.facebook_marketplace.intents.length && acquisitionIntentLabel("reddit_relocation") === "relocators · agent-seekers")
check("the markets panel reads acquisitionIntentLabel", /acquisitionIntentLabel\(key\)/.test(code("app/dashboard/admin/markets/markets-client.tsx")))

console.log("\n  COVERAGE MATRIX (source · populations · vendor · door)")
for (const k of KEYS) console.log(`    ${k.padEnd(28)} ${SOURCE_ACQUISITION[k].intents.join("/").padEnd(40)} ${SOURCE_VENDOR[k].padEnd(10)} ${SOURCE_ACQUISITION[k].entry}`)

// ── L2 · territory ───────────────────────────────────────────────────────────
console.log("\n[L2 · TERRITORY-SCOPED — only active-subscriber territories are scraped]")
const loopAt = route.indexOf("for (const market of markets)")
const resolveAt = route.indexOf("resolveActiveScrapeTerritories(")
check("cron resolves active territories BEFORE the per-market loop", resolveAt > 0 && loopAt > resolveAt)
check("cron's `markets` IS the resolver's territories (no second geography)", /const markets = territoryResolution\.territories/.test(route))
function gateInsideLoop(src: string, key: SourceKey, loopIdx: number): boolean {
  const tokens = [...expandEnabledSources([key])]
  return tokens.some((t) => { const at = src.indexOf(`enabledSources.has("${t}")`); return at > loopIdx && loopIdx >= 0 })
}
const cronKeys = KEYS.filter((k) => SOURCE_ACQUISITION[k].entry === "lead_scraping_cron")
const ungated = cronKeys.filter((k) => !gateInsideLoop(route, k, loopAt))
check(`every cron source's gate token sits inside the resolved-territory loop — ${cronKeys.length - ungated.length}/${cronKeys.length}`, ungated.length === 0, ungated.join(", "))
{
  const fx = `if (enabledSources.has("facebook_marketplace")) {}\nconst t = resolveActiveScrapeTerritories(s)\nfor (const market of markets) {}`
  check("POSITIVE CONTROL: a gate placed BEFORE the territory loop is flagged", !gateInsideLoop(fx, "facebook_marketplace", fx.indexOf("for (const market of markets)")))
}
const push = stripped("app/api/webhooks/batchdata-smart-search/route.ts")
check("batchdata_push door matches every pushed record to a resolved territory before ingest", /resolveActiveScrapeTerritories\(/.test(push) && push.indexOf("resolveActiveScrapeTerritories(") < push.indexOf("ingestRawSourceBatch("))
const li = stripped("app/actions/lead-intelligence.ts")
check("intent_campaign door (scrapeExternalBehavior) refuses a location outside the brokerage's active territories before spending", /resolveActiveScrapeTerritories\(/.test(li) && /outside this brokerage's active scrape territories/.test(li))
check("inbound_mailbox door is the tenant's OWN mailbox ($0, SOURCE_VENDOR internal)", SOURCE_VENDOR.inbound_email_unknown === "internal" && existsSync("lib/lead-pipeline/unknown-sender-identification.ts"))

// ── L3 · linear pipeline ─────────────────────────────────────────────────────
console.log("\n[L3 · LINEAR PIPELINE — raw → dedup → enrich → dedup → territory/identity gate → lead]")
check("cron writes raw records ONLY through insertRawBatch → ingestRawSourceBatch", /await ingestRawSourceBatch\(\{/.test(route) && !/from\("raw_scraped_leads"\)\s*\.insert/.test(route))
check("cron runs the promotion pass (processRawRecord)", /processRawRecord\(/.test(route))
const pp = stripped("lib/lead-pipeline/pipeline-processor.ts")
const order = ["recordMatchesTerritory(", "'pre_enrichment'", "enrichWithPeopleData(", "'post_enrichment'", "evaluateCanonicalLeadEligibility(", ".from('leads')"].map((t) => pp.indexOf(t))
check(`pipeline-processor order: territory gate → dedup(pre) → enrich → dedup(post) → identity gate → lead (${order.join(" < ")})`,
  order.every((x) => x >= 0) && order.every((x, i) => i === 0 || x > order[i - 1]))
const kernel = stripped("lib/kernel/scraping.ts")
check("ingestRawSourceBatch dedups against raw + lead + contact at write time", /export async function ingestRawSourceBatch/.test(kernel) && /export async function dedupRawAgainstLeadAndContact/.test(kernel))
function writesChannel(src: string, ch: string): boolean {
  const c = esc(ch)
  return new RegExp(`insertSocial\\(\\s*[\\w.]+\\s*,\\s*${c}\\s*,`).test(src) || new RegExp(`sourceChannel:\\s*${c}\\s*[,}]`).test(src)
}
const channelled = cronKeys.filter((k) => SOURCE_ACQUISITION[k].routeChannel)
const unwritten = channelled.filter((k) => !writesChannel(route, SOURCE_ACQUISITION[k].routeChannel!))
check(`every cron source's records reach the raw writer under its channel — ${channelled.length - unwritten.length}/${channelled.length}`, unwritten.length === 0, unwritten.join(", "))
check("POSITIVE CONTROL: a channel the route never writes is flagged", !writesChannel(route, '"myspace_intent"'))
const feed = stripped("lib/kernel/listings-batchdata-feed.ts")
check("batchdata_buybox (cron → listings-batchdata-feed) writes through ingestRawSourceBatch", /sourceChannel: "batchdata_buybox"/.test(feed) && /runBuyBoxMatchingForMarket\(/.test(route))
check("signal-only first-party lane (rental_to_buyer_graduation) is gated per brokerage and never mints a raw lead", SOURCE_ACQUISITION.rental_to_buyer_graduation.routeChannel === null && /sourceRentalToBuyerGraduation\(/.test(route))

// ── L4 · platform ledger ─────────────────────────────────────────────────────
console.log("\n[L4 · PLATFORM LEDGER — spend books per source under SOURCE_VENDOR, never a composite]")
const paidKeys = KEYS.filter(PAID)
const misbooked = paidKeys.filter((k) => { const p = planSourceSpendBooking({ source: k, cost: 1, brokerageId: "b" }); return p.vendorUnresolved || p.vendorName !== SOURCE_VENDOR[k] || p.usageType !== k })
check(`every paid source books under its SOURCE_VENDOR vendor with usage_type = SourceKey — ${paidKeys.length - misbooked.length}/${paidKeys.length}`, misbooked.length === 0, misbooked.join(", "))
const aliasCh = ["zillow", "realtor", "redfin", "homes", "craigslist_wanted", "zillow_chatter", "batchdata_incremental", "rental", "linkedin", "exa", "tavily", "google_phrase_intent", "facebook", "reddit", "instagram", "craigslist", "nextdoor"]
const unresolvedCh = aliasCh.filter((c) => vendorForSource(c) === null)
check(`every channel spelling the cron writes resolves to a vendor (${aliasCh.length} channels)`, unresolvedCh.length === 0, unresolvedCh.join(", "))
check("POSITIVE CONTROL: a channel with no SourceKey books under its own name flagged vendor_unresolved",
  (() => { const p = planSourceSpendBooking({ source: "tiktok_intent_x", cost: 1, brokerageId: "b" }); return p.vendorUnresolved && p.vendorName === "tiktok_intent_x" })())
check("a provider override (ZenRows vs Zyte actually served) wins over the contract vendor",
  planSourceSpendBooking({ source: "zillow", cost: 1, brokerageId: "b", providerOverride: "zyte" }).vendorName === "zyte")
check("cron books through bookSourceSpend and no longer writes the composite apify_social row",
  /bookSourceSpend\(/.test(route) && !/scraperTypeToVendor\(|apify_social/.test(route) && /for \(const \[source, cost\] of socialSpendBySource\)/.test(route))
check("POSITIVE CONTROL: the old composite booking shape IS flagged",
  /scraperTypeToVendor\(/.test(`await meterVendorSpend({ vendorName: scraperTypeToVendor("social_intent"), usageType: "social_scrape" })`))
check("bookSourceSpend rides the ONE gateway (meterVendorSpend → vendor_usage_tracking), never a tenant meter",
  /meterVendorSpend\(/.test(code("lib/lead-pipeline/source-cost-ledger.ts")) && !/usage_events|usage_counters|meter_readings/.test(stripped("lib/lead-pipeline/source-cost-ledger.ts")))

// ── L5 · cost per record ─────────────────────────────────────────────────────
console.log("\n[L5 · COST PER RECORD — every paid write carries its batch cost]")
function writeCarriesCost(src: string, ch: string): boolean {
  const c = esc(ch)
  const ins = new RegExp(`insertSocial\\(\\s*[\\w.]+\\s*,\\s*${c}\\s*,\\s*"[a-z_]+"\\s*,\\s*([^,)]+)`).exec(src)
  if (ins) return ins[1].trim() !== "null"
  const at = src.search(new RegExp(`sourceChannel:\\s*${c}\\s*[,}]`))
  if (at < 0) return false
  const block = src.slice(at, src.indexOf("})", at))
  const m = /batchCostUsd:\s*([^,\n]+)/.exec(block)
  return !!m && m[1].trim() !== "null"
}
const paidCron = channelled.filter(PAID)
const costless = paidCron.filter((k) => !writeCarriesCost(route, SOURCE_ACQUISITION[k].routeChannel!))
check(`every paid cron source stamps cost_per_record — ${paidCron.length - costless.length}/${paidCron.length}`, costless.length === 0, costless.join(", "))
check("POSITIVE CONTROL: a write with `batchCostUsd: null` is flagged", !writeCarriesCost(`insertRawBatch({ records, sourceChannel: "batchdata",\n batchCostUsd: null,\n })`, '"batchdata"'))
check("POSITIVE CONTROL: an insertSocial with a null cost is flagged", !writeCarriesCost(`await insertSocial(records, "exa", "social_intent", null)`, '"exa"'))
check("non-cron doors stamp cost too: batchdata_smart_search / batchdata_buybox / external_behavior / incremental",
  /batchCostUsd: perMarketHydrateCost/.test(push) && /batchCostUsd: BUYBOX_MATCH_COST_USD/.test(feed) && /batchCostUsd: pull\.cost/.test(feed) && /batchCostUsd: 3 \* APIFY_ACTOR_CALL_COST_USD/.test(li))
{
  const l = leadCostBySource(
    [{ source: "facebook_marketplace", cost_per_record: 0.005 }, { source: "facebook_marketplace", cost_per_record: 0.005 }, { source: "scraped", source_channel: "craigslist_wanted", cost_per_record: 0.0014 }, { source: "batchdata_motivated", acquisition_cost: 0.3, cost_per_record: 0.05 }],
    [{ vendor_name: "apify", total_cost: 1 }, { vendor_name: "batchdata", total_cost: 0.3 }],
  )
  const fbm = l.bySource.find((r) => r.sourceKey === "facebook_marketplace")
  const apify = l.byVendor.find((v) => v.vendor === "apify")
  check("leadCostBySource: per-source records + cost/record, channel fallback, acquisition_cost preferred",
    fbm?.records === 2 && fbm.costPerRecordUsd === 0.01 && l.bySource.some((r) => r.sourceKey === "craigslist_wanted") && l.bySource.find((r) => r.sourceKey === "batchdata_motivated")?.recordedCostUsd === 0.3)
  check("leadCostBySource: ledger spend no lead carries is surfaced as unattributed (apify $1 vs $0.01 recorded)", !!apify && apify.unattributedUsd === 0.99)
  check("source analytics reads the reconcile (SOURCE_VENDOR ledger reader) and shows the vendor",
    /leadCostBySource\(/.test(code("app/actions/source-analytics.ts")) && /vendorForSource\(/.test(code("app/actions/source-analytics.ts")) && /s\.vendor/.test(code("app/dashboard/analytics/source/source-analytics-client.tsx")))
}

// ── L6 · scheduled ───────────────────────────────────────────────────────────
console.log("\n[L6 · SCHEDULED — every door runs without a human]")
const paths = new Set(CRON_REGISTRY.map((c) => c.path))
const vercel = JSON.parse(read("vercel.json")) as { crons?: Array<{ path: string }> }
check("vercel.json runs the ONE dispatcher (/api/cron/dispatch)", (vercel.crons ?? []).some((c) => c.path === "/api/cron/dispatch"))
check("lead_scraping_cron door is on the dispatcher (/api/cron/lead-scraping)", paths.has("/api/cron/lead-scraping"))
check("intent_campaign door is on the dispatcher and reaches scrapeExternalBehavior", paths.has("/api/cron/intent-campaign") && /scrapeExternalBehavior\(/.test(stripped("lib/kernel/intent-campaign.ts")))
check("batchdata_push is an event-driven webhook route (provider pushes; nothing to schedule)", existsSync("app/api/webhooks/batchdata-smart-search/route.ts"))
check("inbound_mailbox is event-driven (inbound mail webhooks)", existsSync("app/api/webhooks/inbound-mail/route.ts") && existsSync("app/api/providers/inbound/route.ts"))
check("POSITIVE CONTROL: a path absent from the dispatcher reads as unscheduled", !paths.has("/api/cron/tiktok-intent"))

// ── L7 · autonomy + no compliance gate on acquisition ────────────────────────
console.log("\n[L7 · AUTONOMY + NO COMPLIANCE GATING ON ACQUISITION]")
check("the social block no longer requires configured keywords (territory-derived lanes run on the territory alone)",
  /if \(socialSourcesEnabled\) \{/.test(route) && !/socialSourcesEnabled && keywords/.test(route))
check("POSITIVE CONTROL: the old keyword-gated shape IS flagged", /socialSourcesEnabled && keywords/.test(`if (socialSourcesEnabled && keywords && keywords.length > 0) {`))
const COMPLIANCE_GATE = /\b(?:fairHousing\w*|checkFairHousing|complianceGate|requireCompliance|scanCompliance)\s*\(/
const gated = [ROUTE, "lib/lead-pipeline/social-sourcer.ts", "lib/lead-pipeline/source-cost-ledger.ts", "lib/lead-pipeline/acquisition-coverage.ts"].filter((p) => COMPLIANCE_GATE.test(code(p)))
check("no compliance/fair-housing gate call on the acquisition path (it belongs on OUTBOUND content)", gated.length === 0, gated.join(", "))
check("POSITIVE CONTROL: a fair-housing gate call IS flagged", COMPLIANCE_GATE.test(`await checkFairHousing(post)`))

// ── L8 · lane-82B builds ─────────────────────────────────────────────────────
console.log("\n[L8 · builds — Marketplace, BatchData triggers, runtime readers]")
check("ACTOR_REGISTRY.facebook_marketplace has ≥2 candidates, Apify's own actor first", ACTOR_REGISTRY.facebook_marketplace?.length >= 2 && ACTOR_REGISTRY.facebook_marketplace[0] === "apify/facebook-marketplace-scraper")
{
  const owner = normalizeFacebookMarketplaceListing({ id: "1", marketplace_listing_title: "3bd 2ba house for sale by owner", marketplace_listing_seller: { name: "Jane Roe", id: "p1" }, location: { reverse_geocode: { city: "Austin", state: "TX" } }, listing_price: { amount: "350000" } }, { city: "Austin", state: "TX" })
  const agent = normalizeFacebookMarketplaceListing({ id: "2", marketplace_listing_title: "Just listed — call your Realtor", marketplace_listing_seller: { name: "Sam Agent" } }, { city: "Austin", state: "TX" })
  check("Marketplace owner listing → seller, named, FSBO-signalled, geo from the listing", owner.source === "facebook_marketplace" && owner.intentType === "seller" && owner.firstName === "Jane" && owner.intentSignals.includes("fsbo") && owner.city === "Austin")
  check("POSITIVE CONTROL: an agent-posted Marketplace listing is DAMPED (agent_listing), never scored as an owner", agent.intentSignals.includes("agent_listing") && !agent.intentSignals.includes("owner"))
  check("Marketplace is its OWN gate token (not inherited from 'facebook')", expandEnabledSources(["facebook_marketplace"]).has("facebook_marketplace") && !expandEnabledSources(["facebook"]).has("facebook_marketplace"))
}
const newTriggers = ["fsbo", "senior_owner", "canceled_listing", "lis_pendens", "notice_of_default", "involuntary_lien"]
check("BatchData: the six new motivation triggers are pullable", newTriggers.every((t) => (BATCHDATA_MOTIVATION_TYPES as readonly string[]).includes(t)))
check("BatchData: each maps to a PUBLISHED quickList", newTriggers.every((t) => { const s = quickListSlugsFor([t]); return s.length === 1 && BATCHDATA_QUICKLISTS.has(s[0]) }))
check("BatchData: config spellings resolve (by_owner→fsbo, downsizer→senior_owner, withdrawn→canceled_listing, nod→notice_of_default)",
  JSON.stringify(batchDataTriggersFor(["by_owner", "downsizer", "withdrawn", "nod"])) === JSON.stringify(["fsbo", "senior_owner", "canceled_listing", "notice_of_default"]))
check("POSITIVE CONTROL: divorce still has NO quickList (stays on OSINT court records)", !(BATCHDATA_MOTIVATION_TYPES as readonly string[]).includes("divorce") && JSON.stringify(batchDataTriggersFor(["divorce"])) === JSON.stringify(["high_equity", "pre_foreclosure", "absentee"]))
check("cron keeps the BatchData pull's cost (getMotivatedSellerDataWithCost) and books both sources",
  /getMotivatedSellerDataWithCost\(/.test(route) && /source: "batchdata_motivated", cost: motivatedCostUsd/.test(route) && /source: "expired_listing", cost: expiredCostUsd/.test(route))
check("cash-buyer INVESTOR list: 'cash_buyer' maps to the published 'cash-buyer' quickList and is NOT a seller trigger",
  JSON.stringify(quickListSlugsFor(["cash_buyer"])) === JSON.stringify(["cash-buyer"]) && !(BATCHDATA_MOTIVATION_TYPES as readonly string[]).includes("cash_buyer")
  && !batchDataTriggersFor(["cash_buyer"]).includes("cash_buyer"))
check("cron's cash-buyer step relabels records buyer-side under its own source", /source: "batchdata_cash_buyer", intentType: "buyer"/.test(route))
check("craigslist_wanted is a real SourceKey (buyer) — its channel no longer scores as a stranger", resolveSourceKey("craigslist_wanted") === "craigslist_wanted" && SOURCE_ACQUISITION.craigslist_wanted.intents.includes("buy"))

// PAID_ONLY_ANSWERS — runtime planner half
const st = planEnrichmentLane({ enrichmentType: "skip_trace", input: { address: "1 Main", zip: "78701" }, paidAllowed: true })
const pm = planEnrichmentLane({ enrichmentType: "property_match", input: { address: "1 Main" }, paidAllowed: true })
check("PAID_ONLY_ANSWERS read at runtime: skip_trace's paid.answers ⊆ PAID_ONLY_ANSWERS and non-empty",
  st.paid.answers.length > 0 && st.paid.answers.every((a) => (PAID_ONLY_ANSWERS as readonly string[]).includes(a)))
check("POSITIVE CONTROL: property_match (free-only) buys NO paid answers; no free answer is ever paid-only",
  pm.paid.answers.length === 0 && !FREE_OSINT_ANSWERS.some((a) => (PAID_ONLY_ANSWERS as readonly string[]).includes(a)))
check("the orchestrator stamps paid_answers / withheld_answers from the plan", /plan\.paid\.answers/.test(code("lib/lead-pipeline/enrichment-orchestrator.ts")))

// VALID_AGENT_TYPES — boundary normalizer
check("VALID_AGENT_TYPES read at runtime: canonicalAgentType maps aliases onto the roster", canonicalAgentType("isa") === "isa_agent" && canonicalAgentType("coordinator") === "tc_agent" && canonicalAgentType("router") === "router")
check("POSITIVE CONTROL: an off-roster agent_type normalizes to null and gets no registry entry", canonicalAgentType("marketing_agent") === null && getAgentConfig("marketing_agent" as any) === null)
check("router now renders by name (was the bare enum)", getAgentDisplayName("router" as any) === "Router" && VALID_AGENT_TYPES.includes("router"))

// Marketplace wrapper stays territory-honest with no city (no call, no cost)
await (async () => {
  const r = await sourceFacebookMarketplace("", { city: null, state: null })
  check("POSITIVE CONTROL: Marketplace with no territory city makes no call and costs $0", r.records.length === 0 && r.cost === 0)
})()

// bookSourceSpend with an injected logger — per-source row shape
await (async () => {
  const rows: any[] = []
  const logger = async (e: any) => { rows.push(e); return { success: true } as any }
  await bookSourceSpend({ source: "facebook_marketplace", cost: 0.25, brokerageId: "b1", marketId: "m1" }, { logger })
  await bookSourceSpend({ source: "exa", cost: 0.02, brokerageId: "b1", marketId: "m1" }, { logger })
  await bookSourceSpend({ source: "tavily", cost: 0, brokerageId: "b1" }, { logger })
  check("bookSourceSpend writes one platform-ledger row per paid source (vendor + usage_type = SourceKey); $0 books nothing",
    rows.length === 2 && rows[0].vendorName === "apify" && rows[0].usageType === "facebook_marketplace" && rows[1].vendorName === "exa" && rows[1].usageType === "exa_buyer_intent" && rows[0].metadata.market_id === "m1")
})()

// ── L9 · lane 83A — the owner's intents per source + TikTok ───────────────────
console.log("\n[L9 · owner-named intents are declared AND produced; TikTok lane]")
const SM9 = { city: "Austin", state: "TX" }
const fx = (t: string) => t.replace(/\{city\}/g, SM9.city)
// One producer per owner-named source: its REAL parser on a fixture carrying that intent's evidence
// (the source's own default keyword when it reads keywords; the portal CTA marker when it does not).
const OWNER_PRODUCERS: Partial<Record<SourceKey, (i: AcquisitionIntent) => Array<{ intentType?: string | null; intentSignals?: string[] }>>> = {
  realty_site_chatter: (i) => i === "sell"
    ? parseSellerChatter(`<div class="make-me-move" data-user="Jane Roe"><span class="address">1 Main St</span></div>`, "zillow", { city: "Austin", state: "TX" } as any)
    : parseContactAgentChatter(`<div class="contact-agent" data-user="Jane Roe"></div>`, "zillow", { city: "Austin", state: "TX" } as any),
  facebook_marketplace: (i) => [normalizeFacebookMarketplaceListing({ id: `m-${i}`, marketplace_listing_title: fx(DEFAULT_SCRAPE_KEYWORDS.facebook_marketplace?.[i]?.[0] ?? ""), marketplace_listing_seller: { name: "Jane Roe" } }, SM9)],
}
const ownerPairs = (Object.entries(OWNER_REQUIRED_INTENTS) as Array<[SourceKey, readonly AcquisitionIntent[]]>).flatMap(([k, is]) => is.map((i) => [k, i] as const))
const undeclared = ownerPairs.filter(([k, i]) => !SOURCE_ACQUISITION[k].intents.includes(i))
check(`every owner-named (source, intent) is DECLARED in SOURCE_ACQUISITION — ${ownerPairs.length - undeclared.length}/${ownerPairs.length}`, undeclared.length === 0, undeclared.map(([k, i]) => `${k}.${i}`).join(", "))
const unproducedOwner = ownerPairs.filter(([k, i]) => !(OWNER_PRODUCERS[k]?.(i) ?? []).some((r) => recordAcquisitionIntents(r).includes(i)))
check(`every owner-named (source, intent) is PRODUCED by the source's own parser — ${ownerPairs.length - unproducedOwner.length}/${ownerPairs.length}`, unproducedOwner.length === 0, unproducedOwner.map(([k, i]) => `${k}.${i}`).join(", "))
check("owner: site chatter carries SELL", SOURCE_ACQUISITION.realty_site_chatter.intents.includes("sell") && (OWNER_REQUIRED_INTENTS.realty_site_chatter ?? []).includes("sell"))
check("owner: Marketplace carries buy + relocate + realtor_seeking (and keeps FSBO sell)", (["buy", "relocate", "realtor_seeking", "sell"] as AcquisitionIntent[]).every((i) => SOURCE_ACQUISITION.facebook_marketplace.intents.includes(i)))
check("POSITIVE CONTROL: the buyer-only contact-agent parser does NOT produce sell (the old chatter could not)",
  !parseContactAgentChatter(`<div class="contact-agent" data-user="Jane Roe"></div>`, "zillow", { city: "Austin", state: "TX" } as any).some((r) => recordAcquisitionIntents(r).includes("sell")))
check("POSITIVE CONTROL: an anonymous seller CTA (no handle) mints nothing", parseSellerChatter(`<div class="make-me-move">Make Me Move</div>`, "zillow", { city: "Austin", state: "TX" } as any).length === 0)
check("POSITIVE CONTROL: an agent-posted Marketplace listing is still damped, never read as a seeker",
  (() => { const r = normalizeFacebookMarketplaceListing({ id: "x", marketplace_listing_title: "Just listed — call your Realtor", marketplace_listing_seller: { name: "Sam Agent" } }, SM9); return r.intentSignals.includes("agent_listing") && r.intentType === "seller" })())
// TikTok lane
check("TikTok: two Apify tasks with ≥2 candidates each (search → comments)", (ACTOR_REGISTRY.tiktok_search?.length ?? 0) >= 2 && (ACTOR_REGISTRY.tiktok_comments?.length ?? 0) >= 2)
check("TikTok: SourceKey wired (vendor apify, own gate token, channel written, cost carried)",
  SOURCE_VENDOR.tiktok_intent === "apify" && expandEnabledSources(["tiktok_intent"]).has("tiktok") && writesChannel(route, '"tiktok_intent"') && /enabledSources\.has\("tiktok"\) && market\.city/.test(route))
{
  const c = normalizeTikTokComment({ cid: "1", text: "we're moving to Austin next spring, need a realtor!", author: { uniqueId: "janeroe", nickname: "Jane Roe" } }, SM9)
  check("TikTok comment → buyer-side relocator + realtor-seeker anchored on the handle", !!c && c.username === "janeroe" && recordAcquisitionIntents(c).includes("relocate") && recordAcquisitionIntents(c).includes("realtor_seeking"))
  check("POSITIVE CONTROL: a no-intent comment mints nothing", normalizeTikTokComment({ cid: "2", text: "love this song 😍", author: { uniqueId: "x" } }, SM9) === null)
}
await (async () => {
  const r = await sourceTikTokIntent({ city: null, state: "TX" }, ["moving to Austin"])
  check("POSITIVE CONTROL: TikTok with no territory city makes no call and costs $0", r.records.length === 0 && r.cost === 0)
})()

// ── registration ─────────────────────────────────────────────────────────────
console.log("\n[registration]")
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
const guard = pkg.scripts.guard ?? ""
check("package.json registers test:acquisition-coverage", pkg.scripts["test:acquisition-coverage"] === "tsx scripts/acquisition-coverage-guard.ts")
check("guard runs it AFTER test:scrapers (ordering only)", guard.indexOf("npm run test:scrapers") >= 0 && guard.indexOf("npm run test:acquisition-coverage") > guard.indexOf("npm run test:scrapers"))
check("MAINTENANCE_DOMAINS owns it with coOwners", /acquisition_coverage:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:acquisition-coverage",\s*coOwners:/.test(read("lib/kernel/manager-registry.ts")))

console.log(`\n  denominators: ${KEYS.length} SourceKeys · ${cronKeys.length} cron · ${paidKeys.length} paid · ${channelled.length} channel-checked · ${paidCron.length} cost-checked`)
console.log("  blind spots: route-shape checks are text over comment-stripped source (a renamed insertSocial helper would read as unwritten — fails LOUD, never silent); the owner-intent producers run the real parsers on fixtures, not live pages (lead-intelligence's acquisition rows joined the SourceKey reconcile in lane 83A — test:lead-demographics D6)")
console.log(`\n${"─".repeat(50)}\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ ACQUISITION_COVERAGE_FAIL"); process.exit(1) }
console.log(" ✅ ACQUISITION_COVERAGE_PASS")
