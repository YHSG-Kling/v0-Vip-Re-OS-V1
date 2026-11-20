// lib/lead-pipeline/source-discovery-planner.ts
//
// THE SOURCE DISCOVERY PLANNER (wave 150, lane 150EFG — directive lane 150E). PURE: no client, no `server-only`.
//
// Owner directive (150E): "Source Discovery Planner: per territory and market gap, estimated reach, preview counts,
// quotes, budget, expected incremental value and approved acquisition plan" — and, from rule 7: "No autonomous
// purchases, vendor payments." So the plan is a PROPOSAL until a seat that may obligate the tenant to pay approves it,
// and the paid pull itself asks this file (paidPullApproval) before it spends.
//
// SURVIVORS IT PLANS OVER (LAW 1 — it is a planner over the existing acquisition engine, not a second one):
//   · the source catalogue + vendor contract — source-intent-map.ts SOURCE_MAP / SOURCE_VENDOR / sourceRightsFor;
//   · the intents each source serves — acquisition-coverage.ts SOURCE_ACQUISITION;
//   · observed yield + cost per source per territory — raw_scraped_leads (cost_per_record, lead_id, processing_status)
//     read by app/actions/acquisition-plan.ts;
//   · the paid pull it gates — pooled-pull.ts runPooledBatchDataLane (the record-priced licensed buys).
//
// METHOD (the owner-installed PropertyRadar playbook, $S/property-radar-skills — read, never called): PREVIEW FIRST —
// a free count (`purchase=0`) and the estimated cost are shown, an explicit yes is given, only then is anything bought.
// A line with no preview count and no history has no reach to show, so it cannot be proposed for approval. The buy-box
// overlay (EquityPercent ≥ 30) is an INVESTOR play only — a retail seller needs no equity floor. When the distress
// preview counts are near zero the market is a FARMING market (lead with steady first-party / guidance plays), else a
// HUNTING market (motivated-seller pulls earn their cost). Vendor scores and counts keep their own units — the
// expected-lead figures below are observed ratios from this territory's own history, never a probability.

import { SOURCE_MAP, SOURCE_VENDOR, SOURCE_PAID_PERSON_DATA, resolveSourceKey, sourceRightsFor, type SourceKey } from "./source-intent-map"
import { SOURCE_ACQUISITION } from "./acquisition-coverage"
// The REI Playbook v5.5 method has ONE home (wave 150, lane 150KLMO): the investor buy-box criteria and the hunting/farming
// reading come from lib/investor/rei-playbook.ts investorPlay — the two inline literals this planner carried are merged there.
import { investorPlay } from "@/lib/investor/rei-playbook"
// Wave 151 (lane 151C): the freshness policy per signal type, the ONE pre-pull value formula and the aggregate-list preview
// ride every paid plan line — so "check the formula before deciding to pull in a lead" is live in the planner's own decision.
import { expectedSourceFreshness } from "./freshness"
import { evaluatePrePullValue, factorsFromObservedOutcomes, PRE_PULL_VALUE_CONFIG, PRE_PULL_VALUE_DISCLAIMER, type PrePullValueVerdict } from "./pre-pull-value"
import { previewAggregateList, type AggregateListPreview } from "./pre-pull-dedup"
// Wave 151 (lane 151F, integrated with 151C): the ONE reading of why a verdict refuses a paid want — paidPullApproval consumes
// it before the approval is looked up (the verdict type is 151C's; budget-eval re-exports it).
import { prePullRefusal } from "@/lib/vendor-governance/budget-eval"
import { datafinitiDatasetSelection } from "./datafiniti-dataset-door"

/** The acquisition plays the owner named (buyer AND seller), one vocabulary. */
const ACQUISITION_PLAYS = [
  "renter_to_owner", "relocation", "owner_equity", "downsizing", "first_party_search",
  "supply_demand_gap", "voluntary_guidance", "investor_buy_box",
] as const
type AcquisitionPlay = (typeof ACQUISITION_PLAYS)[number]

/** Which plays each source serves. Typed over SourceKey, so a new source cannot ship unplanned. */
const SOURCE_PLAYS: Record<SourceKey, readonly AcquisitionPlay[]> = {
  batchdata_motivated: ["owner_equity", "downsizing"], batchdata_smart_search: ["owner_equity", "downsizing"],
  osint_signal: ["owner_equity"], expired_listing: ["supply_demand_gap"], fsbo_site_listing: ["supply_demand_gap"],
  // Wave 153 (lane 153M): an identity / contact record carries no acquisition play — none is invented for it (owner B5).
  datafiniti_people: [],
  craigslist_fsbo: ["supply_demand_gap"], zenrows_zillow: ["supply_demand_gap"], zenrows_realtor: ["supply_demand_gap"],
  zenrows_homes: ["supply_demand_gap"], permit_prelisting_intent: ["supply_demand_gap", "downsizing"],
  rental_listing: ["supply_demand_gap"], facebook_marketplace: ["supply_demand_gap"], external_behavior: ["supply_demand_gap"],
  rental_to_buyer_graduation: ["renter_to_owner"], linkedin_relocation: ["relocation"], reddit_relocation: ["relocation"],
  craigslist_wanted: ["relocation", "renter_to_owner"], site_visitor_intent: ["first_party_search"],
  email_engagement_intent: ["first_party_search"], inbound_email_unknown: ["first_party_search", "voluntary_guidance"],
  review_acquisition_intent: ["voluntary_guidance"], agent_seeking_phrase_intent: ["voluntary_guidance"],
  facebook_recommend_realtor: ["voluntary_guidance"], nextdoor_intent: ["voluntary_guidance"], facebook_group: ["voluntary_guidance"],
  reddit_intent: ["voluntary_guidance"], instagram_intent: ["voluntary_guidance"], google_phrase_intent: ["voluntary_guidance"],
  tavily_intent: ["voluntary_guidance"], exa_buyer_intent: ["voluntary_guidance", "relocation"],
  realty_site_chatter: ["voluntary_guidance"], new_construction_intent: ["voluntary_guidance", "relocation"],
  batchdata_cash_buyer: ["investor_buy_box"], batchdata_buybox: ["investor_buy_box"],
}

type AcquisitionSide = "buyer" | "seller" | "both"

function sideOf(source: SourceKey): AcquisitionSide {
  const intents = SOURCE_ACQUISITION[source]?.intents ?? []
  const buy = intents.some((i) => i === "buy" || i === "relocate" || i === "investor")
  const sell = intents.includes("sell")
  return buy && sell ? "both" : sell ? "seller" : "buyer"
}

interface PlannerTerritory { id: string; brokerageId: string; label: string }

/** Verified market context (RentCast ZIP market data — lane 150KLMO's twin). Absent = balanced, said so. */
interface MarketGap { monthsOfSupply?: number | null; asOf?: string | null; source?: string | null }

/** What this territory's own history says about one source (read from raw_scraped_leads, never estimated).
 *  `heldStale` (wave 151): rows the freshness policy held (processing_status 'held_stale' / freshness_verdict stale|history);
 *  undefined = the caller could not count them yet (published as a blind spot). */
export interface SourceHistory { rawRows: number; promoted: number; duplicates: number; costUsd: number; heldStale?: number | null }

/** A FREE preview count (a provider's count / purchase=0 endpoint, or a first-party table count). */
export interface SourcePreview { count: number; at: string; via: string }

/** A price per record from a quote or the catalogue — never a guess. */
export interface SourceQuote { unitUsd: number; minimumUsd?: number | null; basis: "provider_quote" | "catalogue" | "history" }

/**
 * The quickList lanes whose count reads as DISTRESS for the hunting-vs-farming question (rei-list-builder step 4 —
 * preforeclosure / tax-delinquent / vacant and the recorded foreclosure stages), named by the slugs
 * lib/external/batchdata-client.ts BATCHDATA_QUICKLIST_CATALOGUE carries.
 */
const DISTRESS_QUICKLIST_LANES: ReadonlySet<string> = new Set([
  "preforeclosure", "notice-of-sale", "tax-default", "vacant", "notice-of-lis-pendens", "notice-of-default", "active-auction", "involuntary-lien",
])

/**
 * CONVERGENCE ROW 23 (wave 152, lane 152K) — "BatchData count into the plan", built WITHOUT a new provider call.
 * BatchData documents the count as `results.meta.results.resultsFound` on every Property Search response and bills per
 * RETURNED record (`resultCount`); it documents no free count-only endpoint. So a proposal (which never spends) reads
 * the count BatchData ALREADY returned on this territory's own paid incremental pulls — persisted per (market, lane) in
 * `batchdata_incremental_search_state.results_found` by lib/kernel/listings-batchdata-feed.ts — and never asks again.
 * PURE. A lane's count is used only when it is a non-negative number observed within `maxAgeDays`; lanes overlap, so
 * the motivated line's reach is the LARGEST single-lane count (a lower bound on the union — never a sum); the distress
 * count is the largest fresh distress lane (null when none → the planner still says "unknown").
 */
export function previewsFromObservedSearchCounts(
  rows: ReadonlyArray<{ lane: string | null; results_found: number | null; updated_at?: string | null; last_run_at?: string | null }>,
  opts: { now: Date; maxAgeDays: number },
): { previews: Partial<Record<SourceKey, SourcePreview>>; distressPreviewCount: number | null; used: number; stale: number } {
  const cutoff = opts.now.getTime() - opts.maxAgeDays * 86_400_000
  let best: { count: number; lane: string; at: string } | null = null
  let distress: number | null = null
  let used = 0, stale = 0
  for (const r of rows) {
    const n = r.results_found
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || !r.lane) continue
    const at = r.last_run_at ?? r.updated_at ?? null
    const t = at ? Date.parse(at) : NaN
    if (!Number.isFinite(t) || t < cutoff) { stale++; continue }
    used++
    const count = Math.floor(n)
    if (!best || count > best.count) best = { count, lane: r.lane, at: at as string }
    if (DISTRESS_QUICKLIST_LANES.has(r.lane)) distress = Math.max(distress ?? 0, count)
  }
  const previews: Partial<Record<SourceKey, SourcePreview>> = {}
  if (best) previews.batchdata_motivated = { count: best.count, at: best.at, via: `BatchData's own count on this territory's last paid pull (${best.lane}, ${best.at.slice(0, 10)}) — the largest of ${used} lane${used === 1 ? "" : "s"}, a lower bound; no new call` }
  return { previews, distressPreviewCount: distress, used, stale }
}

/** `held` (wave 151, lane 151C): the pre-pull value formula held the line — never approvable, re-preview first. */
type PlanLineStatus = "free_ready" | "proposed" | "needs_preview" | "needs_quote" | "over_budget" | "blocked_rights" | "held" | "provider_preferred" | "approved" | "ideas_only"

// ─── IDEAS-ONLY ROUTES (wave 155, lane 155H — owner ruling R12, directive H1 / binding decision 12) ─────────────────────
// "Facebook Groups / Meta ads / competitors / Nextdoor stay IDEAS-ONLY." At the batch-2 base (d2d6468c) the three SourceKeys
// below were ordinary acquisition lines: with a preview and a quote planSourceDiscovery PROPOSED them, an approved plan line
// opened resolveSourceDoor for them, and app/api/cron/lead-scraping/route.ts (which asks resolveSourceDoor for every configured
// per-territory source before it builds enabledSources) would file their posts as Raw Leads. Their content reaches the ONE
// topic intake instead (lib/content-intel/public-chatter-topics.ts — Nextdoor posts, Facebook group questions, Meta Ad
// Library creatives, reworded, no author, no contact). Meta ads and competitor posts have no SourceKey (they never were an
// acquisition line). A self-identified public person stating their own need is path B (lib/acquisition-plays/public-request.ts).
export const IDEAS_ONLY_SOURCES: ReadonlySet<SourceKey> = new Set<SourceKey>(["facebook_group", "facebook_recommend_realtor", "nextdoor_intent"])

/** PURE — why `source` may never become a Raw Lead (null = not an ideas-only route). Aliases resolve first ("nextdoor"). */
export function ideasOnlySourceProblem(source: string): string | null {
  const key = resolveSourceKey(String(source ?? ""))
  return IDEAS_ONLY_SOURCES.has(key)
    ? `${key} is an IDEAS-ONLY route (owner ruling R12): its public posts feed the topic pool through the one topic intake, reworded — never a Raw Lead, a purchased person or an outreach list`
    : null
}

// ─── PROVIDER FIRST (wave 153, lane 153N — owner ruling B3, verbatim: "scraping needs to be current data but if you can get
// the info from a data provider, then that is the safer bet") ───────────────────────────────────────────────────────────
//
// A SCRAPED source line whose FACT a configured data provider also supplies is not planned — the provider is. Each row names
// the fact, the provider and the documented endpoint that carries it (never a guess): only facts the repo's own vendored
// provider contracts show. Lines with no row (FSBO pages, need chatter, reviews) have no provider equivalent and stay planned.
export const PROVIDER_FIRST_FACTS: Readonly<Partial<Record<SourceKey, { fact: string; providers: ReadonlyArray<{ provider: string; endpoint: string }> }>>> = Object.freeze({
  rental_listing: {
    fact: "active long-term rental listings in the territory",
    providers: [{ provider: "rentcast", endpoint: "RentCast GET /listings/rental/long-term (lib/external/_generated/rentcast-openapi.ts)" }],
  },
})

/** PURE — does a configured data provider supply this scraped line's fact? (null = no — the scrape may be planned). */
export function providerFirstVerdict(source: SourceKey, configuredProviders: readonly string[]): { provider: string; fact: string; endpoint: string } | null {
  if (SOURCE_VENDOR[source] === "internal") return null
  const row = PROVIDER_FIRST_FACTS[source]
  if (!row) return null
  const hit = row.providers.find((p) => configuredProviders.includes(p.provider))
  return hit ? { provider: hit.provider, fact: row.fact, endpoint: hit.endpoint } : null
}

export interface PlanLine {
  source: SourceKey
  plays: readonly AcquisitionPlay[]
  side: AcquisitionSide
  vendor: string
  rights: string
  paid: boolean
  previewCount: number | null
  previewVia: string | null
  estimatedReach: number | null
  quoteUsd: number | null
  quoteBasis: SourceQuote["basis"] | null
  expectedNewLeads: number | null
  /** How expectedNewLeads was derived — an observed ratio from this territory, or nothing to derive it from. */
  expectedBasis: "territory_history" | "no_history"
  costPerExpectedLead: number | null
  /** INVESTOR plays only (the buy-box overlay); a retail seller line carries none. */
  criteria: Record<string, unknown> | null
  /** Wave 151 (lane 151C): the freshness a pull from this source is EXPECTED to deliver (lib/lead-pipeline/freshness.ts policy). */
  freshness: { factor: number; policy: string; why: string }
  /** Wave 151 (lane 151C): the pre-pull value verdict of a PAID line (lib/lead-pipeline/pre-pull-value.ts) — null on a free line.
   *  A `hold` keeps the line out of the approvable set; the disclaimer rides with it. */
  value: PrePullValueVerdict | null
  /** Wave 151 (lane 151C): the cost / count / freshness PREVIEW of the aggregate list — a count, never contacts. */
  dedupPreview: AggregateListPreview | null
  status: PlanLineStatus
  why: string
  approvedAt?: string | null
  approvedByUserId?: string | null
  maxSpendUsd?: number | null
}

export interface AcquisitionPlan {
  territoryId: string
  brokerageId: string
  territoryLabel: string
  budgetUsd: number
  totalQuoteUsd: number
  marketMode: "hunting" | "farming" | "unknown"
  tilt: "seller" | "buyer" | "balanced"
  lines: PlanLine[]
  balance: { buyerLines: number; sellerLines: number }
  blindSpots: string[]
  plannerVersion: string
}

/** @2 (wave 151, lane 151C): every line carries freshness, the pre-pull value verdict and the aggregate preview; `held` status. */
const SOURCE_DISCOVERY_PLANNER_VERSION = "source-discovery@2"

// TOMBSTONE (wave 150, lane 150KLMO — orphan doctrine §1.1): FARMING_DISTRESS_FLOOR (25) moved to
// lib/investor/rei-playbook.ts FARMING_DISTRESS_FLOOR, read through investorPlay({ audience: "market_mode" }) below.

/**
 * PURE — the acquisition plan for one territory. Free first-party lines are always included (they spend nothing);
 * paid lines are proposed only with a preview count (or observed history) AND a quote, ranked by cost per expected
 * new lead, filled within the budget — with at least one buyer-side and one seller-side line kept when one exists, and
 * the side the market gap favours preferred.
 */
export function planSourceDiscovery(input: {
  territory: PlannerTerritory
  budgetUsd: number
  enabledSources?: readonly SourceKey[] | null
  history: Partial<Record<SourceKey, SourceHistory>>
  previews: Partial<Record<SourceKey, SourcePreview>>
  quotes: Partial<Record<SourceKey, SourceQuote>>
  marketGap?: MarketGap | null
  /** Free preview count of distress candidates (preforeclosure / tax-delinquent / vacant …) — hunting vs farming. */
  distressPreviewCount?: number | null
  /** Wave 151 (lane 151C): what each USABLE record then costs to enrich / reason about (the value formula's downstream cost). */
  enrichmentUsdPerRecord?: number | null
  aiUsdPerRecord?: number | null
  /** Wave 153 (lane 153N): the data providers holding a configured key (NAMES only) — the provider-first rule reads it. */
  configuredProviders?: readonly string[] | null
  now?: Date
}): AcquisitionPlan {
  const blindSpots: string[] = []
  const now = input.now ?? new Date()
  const mos = input.marketGap?.monthsOfSupply
  const tilt: AcquisitionPlan["tilt"] = typeof mos === "number" ? (mos < 3 ? "seller" : mos > 6 ? "buyer" : "balanced") : "balanced"
  if (typeof mos !== "number") blindSpots.push("no verified months-of-supply for this territory — buyer and seller lines are weighed evenly")
  const mode = investorPlay({ audience: "market_mode", distressPreviewCount: input.distressPreviewCount ?? null })
  const marketMode: AcquisitionPlan["marketMode"] = mode.ok && mode.kind === "market_mode" ? mode.marketMode : "unknown"
  // The Buy Box (investor lines only): the playbook's PREVIEW criteria in PropertyRadar's confirmed vocabulary, purchase 0.
  const buyBox = investorPlay({ audience: "investor", play: "buy_box" })
  if (marketMode === "unknown") blindSpots.push("no distress preview count — hunting vs farming is not known")

  const keys = (input.enabledSources && input.enabledSources.length > 0 ? input.enabledSources : (Object.keys(SOURCE_MAP) as SourceKey[]))
    .filter((k) => k in SOURCE_PLAYS)
  const lines: PlanLine[] = keys.map((source) => {
    const vendor = SOURCE_VENDOR[source]
    const rights = sourceRightsFor(source).rights
    const paid = vendor !== "internal"
    const h = input.history[source]
    const p = input.previews[source]
    const q = input.quotes[source]
    const reach = p ? p.count : h && h.rawRows > 0 ? h.rawRows : null
    const ratio = h && h.rawRows > 0 ? Math.max(0, h.promoted) / h.rawRows : null
    const expected = reach !== null && ratio !== null ? Math.round(reach * ratio * 10) / 10 : null
    const quote = paid && q && reach !== null ? Math.round(Math.max(q.unitUsd * reach, q.minimumUsd ?? 0) * 100) / 100 : paid ? null : 0
    const investor = SOURCE_PLAYS[source].includes("investor_buy_box")
    const side = sideOf(source)
    // Wave 151 (lane 151C) — THE PRE-PULL FORMULA, before any approval: expected freshness from the source's signal-type
    // policy, reliability / identity-match / overlap from this territory's OWN observed outcomes (shrunk toward unknown on a
    // thin sample), the fields a record adds (a vendor that sells the person's contact points adds more than a page scrape —
    // configured, not measured), the market-favoured side as the opportunity factor, the quote and downstream costs against
    // the budget. The verdict rides the line with its disclaimer; a `hold` keeps the line out of the approvable set.
    const freshness = expectedSourceFreshness(source, now)
    const observed = factorsFromObservedOutcomes(h ? { rawRows: h.rawRows, promoted: h.promoted, duplicates: h.duplicates, heldStale: h.heldStale ?? null } : null)
    const value: PrePullValueVerdict | null = paid ? evaluatePrePullValue({
      factors: {
        territoryMatch: 1, // planned over the territory's own geography; pooled-pull.ts fans records back by containment
        freshness: Math.round(freshness.factor * (1 - (observed.freshnessPenalty ?? 0)) * 100) / 100,
        sourceReliability: observed.sourceReliability,
        expectedNewUsableFields: SOURCE_PAID_PERSON_DATA[source] ? 0.8 : 0.4,
        identityMatchLikelihood: observed.identityMatchLikelihood,
        usefulOpportunityFactor: tilt === "balanced" ? 0.6 : side === tilt || side === "both" ? 0.8 : 0.4,
      },
      adjustments: { knownOverlapRatio: observed.knownOverlapRatio, observedUsableRatio: observed.observedUsableRatio, uncertainty: (observed.basis === "no_history" ? 0.3 : 0) + (p ? 0 : 0.2) },
      cost: { recordCount: reach ?? 0, providerUnitUsd: q?.unitUsd ?? null, minimumUsd: q?.minimumUsd ?? null, enrichmentUsdPerRecord: input.enrichmentUsdPerRecord ?? null, aiUsdPerRecord: input.aiUsdPerRecord ?? null, paid },
      budget: { authorizedUsd: input.budgetUsd },
      // Wave 154 (lane 154J, directive J3): say which of the factors above are MEASURED (this territory's own outcomes) and
      // which are CONFIGURED planner weights (territory 1, fields 0.8 / 0.4, the side tilt) — so a configured weight never
      // reads as a measurement. The planner does not know which specific fields a line would fill: that input stays UNKNOWN.
      context: {
        basis: { territoryMatch: "configured", freshness: observed.freshnessPenalty === null ? "configured" : "measured", expectedNewUsableFields: "configured", usefulOpportunityFactor: "configured" },
        rights, missingFields: null, priceBasis: q?.basis ?? null,
      },
    }) : null
    const line: PlanLine = {
      source, plays: SOURCE_PLAYS[source], side, vendor, rights, paid,
      previewCount: p?.count ?? null, previewVia: p?.via ?? null, estimatedReach: reach,
      quoteUsd: quote, quoteBasis: paid ? q?.basis ?? null : null,
      expectedNewLeads: expected, expectedBasis: ratio !== null ? "territory_history" : "no_history",
      costPerExpectedLead: paid && quote !== null && expected && expected > 0 ? Math.round((quote / expected) * 100) / 100 : null,
      criteria: investor && buyBox.ok && buyBox.kind === "play"
        ? { equityPercentMin: buyBox.equityPercentMin, note: "buy-box overlay — investor plays only (REI Playbook v5.5, a labelled heuristic)", preview: buyBox.preview, unconfirmed: buyBox.unconfirmed }
        : null,
      freshness: { factor: freshness.factor, policy: freshness.policy, why: freshness.why },
      value,
      dedupPreview: paid ? previewAggregateList({
        source, count: reach, unitUsd: q?.unitUsd ?? null, minimumUsd: q?.minimumUsd ?? null, knownOverlapRatio: observed.knownOverlapRatio,
        freshness: { factor: freshness.factor, policy: freshness.policy }, via: p?.via ?? (h && h.rawRows > 0 ? "own history" : "none"),
      }) : null,
      status: "proposed", why: "",
    }
    const preferred = providerFirstVerdict(source, input.configuredProviders ?? [])
    const ideasOnly = ideasOnlySourceProblem(source)
    if (ideasOnly) { line.status = "ideas_only"; line.why = ideasOnly }
    else if (rights === "unknown") { line.status = "blocked_rights"; line.why = "no rights basis names this source" }
    else if (preferred) { line.status = "provider_preferred"; line.why = `${preferred.provider} supplies ${preferred.fact} (${preferred.endpoint}) — a data provider is the safer source than a scrape (owner ruling B3)` }
    else if (!paid) { line.status = "free_ready"; line.why = "first-party — the tenant's own data, no vendor call, no spend" }
    else if (reach === null) { line.status = "needs_preview"; line.why = "no free preview count and no history — nothing to show before buying" }
    else if (quote === null) { line.status = "needs_quote"; line.why = "no quote / catalogue price for this source" }
    else if (value && value.decision === "hold") { line.status = "held"; line.why = `held by the pre-pull value formula (${value.version}) — ${value.reasons.join("; ")}` }
    else if (value && value.decision === "preview_first" && !p) { line.status = "needs_preview"; line.why = `preview first — ${value.reasons.join("; ")}` }
    return line
  })

  // Paid candidates, ranked: known cost per expected lead first (cheapest), the market-favoured side weighted 20 %.
  const weight = (l: PlanLine) => {
    const base = l.costPerExpectedLead ?? Number.POSITIVE_INFINITY
    const favoured = tilt !== "balanced" && (l.side === tilt || l.side === "both")
    return favoured ? base * 0.8 : base
  }
  // Ranked by observed cost per expected new lead; the pre-pull value (higher first) breaks ties before the raw quote.
  const candidates = lines.filter((l) => l.status === "proposed").sort((a, b) => weight(a) - weight(b) || (b.value?.score ?? 0) - (a.value?.score ?? 0) || (a.quoteUsd ?? 0) - (b.quoteUsd ?? 0))
  let spent = 0
  const keep = new Set<PlanLine>()
  const fits = (l: PlanLine) => spent + (l.quoteUsd ?? 0) <= input.budgetUsd
  // Balance first: the best buyer-side and the best seller-side line, when each fits.
  for (const side of ["seller", "buyer"] as const) {
    const pick = candidates.find((l) => !keep.has(l) && (l.side === side || l.side === "both") && fits(l))
    if (pick) { keep.add(pick); spent += pick.quoteUsd ?? 0 }
  }
  for (const l of candidates) {
    if (keep.has(l)) continue
    if (fits(l)) { keep.add(l); spent += l.quoteUsd ?? 0 }
  }
  for (const l of candidates) {
    if (keep.has(l)) { l.why = `preview ${l.estimatedReach} × quote $${l.quoteUsd}${l.costPerExpectedLead !== null ? ` ≈ $${l.costPerExpectedLead} per expected new lead (observed)` : " — no history to estimate new leads"}${l.value ? ` · value ${l.value.score} (${l.value.version}, ${l.value.calibration})` : ""}` }
    else { l.status = "over_budget"; l.why = `$${l.quoteUsd} does not fit the remaining budget` }
  }
  if (marketMode === "farming") {
    for (const l of lines) if (l.plays.includes("owner_equity") && l.status === "proposed") l.why += " · farming market: distress counts are thin — the first-party and guidance plays lead"
  }
  const chosen = lines.filter((l) => l.status === "proposed" || l.status === "free_ready")
  if (!chosen.some((l) => l.side !== "seller")) blindSpots.push("no buyer-side line could be planned")
  if (!chosen.some((l) => l.side !== "buyer")) blindSpots.push("no seller-side line could be planned")
  blindSpots.push("expected new leads are this territory's own observed promotion ratio — a source never run here has none")
  blindSpots.push(`pre-pull value: ${PRE_PULL_VALUE_CONFIG.version} (${PRE_PULL_VALUE_CONFIG.calibration}) — ${PRE_PULL_VALUE_DISCLAIMER}`)
  const heldLines = lines.filter((l) => l.status === "held").length
  if (heldLines > 0) blindSpots.push(`${heldLines} paid line(s) held by the value formula — not approvable until re-previewed`)
  if (Object.values(input.history).some((h) => h && h.heldStale === undefined)) blindSpots.push("held-stale history is counted from processing_status 'held_stale' only until m967's freshness_verdict is live")
  return {
    territoryId: input.territory.id, brokerageId: input.territory.brokerageId, territoryLabel: input.territory.label,
    budgetUsd: input.budgetUsd, totalQuoteUsd: Math.round(spent * 100) / 100, marketMode, tilt, lines,
    balance: { buyerLines: chosen.filter((l) => l.side !== "seller").length, sellerLines: chosen.filter((l) => l.side !== "buyer").length },
    blindSpots, plannerVersion: SOURCE_DISCOVERY_PLANNER_VERSION,
  }
}

/** How long an approval stands before the plan must be re-previewed and re-approved (counts and prices move). */
const ACQUISITION_APPROVAL_DAYS = 90

/**
 * PURE — approve named PROPOSED lines of a plan. Refuses unless the approver may obligate the tenant to pay
 * (TENANT_COMMERCE_ADMIN_USER_TYPES — checked by the caller, passed in), and never approves a line that is not
 * `proposed` (no preview, no quote, over budget, blocked rights — "never a paid call without approval" also means
 * never an approval without a preview and a price).
 */
export function approvePlanLines(
  lines: readonly PlanLine[],
  approve: readonly string[],
  approver: { userId: string; mayCommitSpend: boolean },
  now: Date = new Date(),
): { ok: true; lines: PlanLine[]; approved: string[]; validUntil: string } | { ok: false; reason: string } {
  if (!approver.mayCommitSpend) return { ok: false, reason: "this seat may not obligate the tenant to pay a vendor" }
  const want = new Set(approve)
  const refused = lines.filter((l) => want.has(l.source) && l.status !== "proposed").map((l) => `${l.source} (${l.status})`)
  if (refused.length > 0) return { ok: false, reason: `only proposed lines can be approved: ${refused.join(", ")}` }
  const at = now.toISOString()
  const out = lines.map((l) => want.has(l.source) ? { ...l, status: "approved" as const, approvedAt: at, approvedByUserId: approver.userId, maxSpendUsd: l.quoteUsd } : l)
  const approved = out.filter((l) => l.status === "approved").map((l) => l.source)
  if (approved.length === 0) return { ok: false, reason: "no line named for approval" }
  return { ok: true, lines: out, approved, validUntil: new Date(now.getTime() + ACQUISITION_APPROVAL_DAYS * 86_400_000).toISOString() }
}

export interface StoredPlanRow { id: string; brokerage_id: string; status: string; valid_until: string | null; lines: unknown }

// ─── THE SOURCE DOOR — IF / THEN (wave 151, lane 151C) ─────────────────────────────────────────────────────────────
//
// Owner, verbatim (wave 151): "raw leads and providers should follow an if then so if a provider is hooked up from
// platform, the provider will pull in raw leads from scrapers and/or a list provider and you set it up way too strict
// which could possibly block providers completely". The wave-150 gate (OWNER-SQL §L L6.7) refused EVERY per-territory
// paid source without an approved plan line — including a platform-connected, licensed provider the platform already
// pays for. Re-asserted here to the RULE:
//
//   IF  an approved, unexpired plan line names the source               → approved_plan  (ceiling = the line's maxSpendUsd)
//   ELSE IF the platform's own connection for the vendor is configured
//           (credential present BY NAME), licensed (rights basis named,
//           activation not pending rights / closed) and the territory
//           has a monthly budget with money left                        → platform_provider (ceiling = the territory's monthly budget,
//                                                                          measured since the first of the month)
//   ELSE IF a tenant-owned connection for the vendor is connected,
//           healthy and authorized                                      → tenant_provider (the tenant's own account; the territory
//                                                                          budget still bounds the records)
//   ELSE IF the source is a permissible keyless public source           → public_source (no vendor, no spend)
//   ELSE                                                                → unavailable — a REAL provider-unavailable result that
//                                                                          names every door tried and why it closed
//
// Every allowed door lands in the ONE RawData producer with the same idempotency / identity rules; this only chooses the
// transport and its ceiling. Nothing here reads an environment value: the caller passes `configured` (a presence check by
// NAME — pooled-pull.ts platformProviderDoorFacts) so no secret can reach a tenant through a reason string.

/** The platform's own connection for one vendor, as FACTS the caller established (never a credential value). */
export interface PlatformProviderDoor {
  vendor: string
  /** The platform holds this vendor's credential — a presence check by env NAME, never a value. */
  configured: boolean
  /** The NAMES checked (so an "unconfigured" reason can say which, without a value). */
  credentialNames: readonly string[]
  /** lib/ai-isa/property-lookup-rail.ts PROVIDER_ACTIVATION state, or "scraper_fleet" for the platform-metered scraper lanes. */
  activation: "active" | "dormant_survivor" | "dormant_pending_rights" | "scraper_fleet" | "unknown"
  /** R9: a dormant survivor's live doors stay open until the owner closes them (OWNER-SQL §L L6.5). */
  survivorDoors?: "closed" | "owner_confirmation_pending" | null
  /** The territory's monthly budget and what is left of it this month (null = no territory / no budget known). */
  monthlyBudgetUsd: number | null
  remainingBudgetUsd: number | null
  /** The platform's internal acquisition cap for the cycle, when the budget owner supplies it (lane 151F). */
  platformCapUsd?: number | null
}

/** A tenant-owned connection for one vendor, as the connection cascade reports it (lib/connections/resolve-scoped.ts). */
export interface TenantProviderDoor {
  vendor: string
  status: "connected" | "not_connected" | "unreadable"
  healthy: boolean
  /** The tenant authorized acquisition use of its own account (not merely connected it for another purpose). */
  authorized: boolean
  detail?: string | null
}

export type SourceDoor = "first_party" | "approved_plan" | "platform_provider" | "tenant_provider" | "public_source" | "unavailable"

export interface SourceDoorVerdict {
  door: SourceDoor
  allowed: boolean
  reason: string
  vendor: string | null
  paid: boolean
  /** The spend ceiling the chosen door carries (budget-eval.ts decideSpendBackpressure sizes the pull against it). */
  maxSpendUsd: number | null
  /** Where the ceiling is measured from (an approval's date; the first of the month for a budget door). */
  approvedAt: string | null
  planId: string | null
  /** Every door tried before this one, with why it closed — the honest trail behind an `unavailable`. */
  tried: string[]
  /** The pre-pull value verdict, when the caller evaluated one: a hold / refuse closes an otherwise open door. */
  value: PrePullValueVerdict | null
}

export interface SourceDoorContext {
  platform?: PlatformProviderDoor | null
  tenant?: TenantProviderDoor | null
  value?: PrePullValueVerdict | null
}

const monthStartIso = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()

/** The wave-150 rule, unchanged: an APPROVED, unexpired plan line of THAT tenant naming THAT source. */
function approvedPlanLine(
  plans: readonly StoredPlanRow[] | null,
  want: { brokerageId: string | null; source: string },
  now: Date = new Date(),
): { allowed: true; planId: string; maxSpendUsd: number | null; approvedAt: string | null } | { allowed: false; reason: string } {
  if (plans === null) return { allowed: false, reason: "the acquisition-plan store could not be read" }
  if (!want.brokerageId) return { allowed: false, reason: "no tenant owns this share — a platform pull needs a tenant's approval" }
  // Wave 155 (155H, R12): an approval stored before the ruling cannot reopen an ideas-only route.
  const ideasOnly = ideasOnlySourceProblem(want.source)
  if (ideasOnly) return { allowed: false, reason: ideasOnly }
  for (const p of plans) {
    if (p.brokerage_id !== want.brokerageId || p.status !== "approved") continue
    if (!p.valid_until || Date.parse(p.valid_until) < now.getTime()) continue
    const lines = Array.isArray(p.lines) ? (p.lines as PlanLine[]) : []
    const line = lines.find((l) => l && l.source === want.source && l.status === "approved")
    // approvedAt (wave 150, lane 150HIAB): the spend booked SINCE the approval is what the ceiling is measured against
    // (pooled-pull.ts → budget-eval.ts decideSpendBackpressure).
    if (line) return { allowed: true, planId: p.id, maxSpendUsd: line.maxSpendUsd ?? null, approvedAt: line.approvedAt ?? null }
  }
  return { allowed: false, reason: `no approved, unexpired acquisition plan approves ${want.source} for this tenant` }
}

/**
 * PURE — WHICH DOOR may this source be pulled through for this tenant, in the owner's IF / THEN order. Never guesses a
 * rights basis (unknown → unavailable), never reads a credential value, and a configured, licensed platform provider is
 * NOT blocked for want of a plan line — while an unconfigured one is still refused, honestly, by name.
 */
export function resolveSourceDoor(input: {
  source: string
  brokerageId: string | null
  plans: readonly StoredPlanRow[] | null
  platform?: PlatformProviderDoor | null
  tenant?: TenantProviderDoor | null
  value?: PrePullValueVerdict | null
  now?: Date
}): SourceDoorVerdict {
  const now = input.now ?? new Date()
  const rights = sourceRightsFor(input.source)
  const vendor = rights.vendor
  const tried: string[] = []
  const value = input.value ?? null
  const base = (door: SourceDoor, allowed: boolean, reason: string, paid: boolean, extra: Partial<Pick<SourceDoorVerdict, "maxSpendUsd" | "approvedAt" | "planId">> = {}): SourceDoorVerdict => ({
    door, allowed, reason, vendor, paid, maxSpendUsd: extra.maxSpendUsd ?? null, approvedAt: extra.approvedAt ?? null, planId: extra.planId ?? null, tried, value,
  })
  const withValue = (v: SourceDoorVerdict): SourceDoorVerdict => {
    // ONE reading of a refusing verdict (lane 151F's prePullRefusal on lane 151C's verdict: hold / refuse / an out-of-bounds
    // score) — never a second spelling here. proceed and preview_first pass; preview_first is the plan line's own status.
    const why = value ? prePullRefusal(value) : null
    if (!v.allowed || !why) return v
    return { ...v, allowed: false, reason: `${v.door} door open, but the pre-pull value formula ${value!.decision === "hold" ? "holds" : "refuses"} this pull — ${why}` }
  }

  // Wave 155 (155H, R12): FIRST — no plan, provider, tenant connection or public-source door opens an ideas-only route.
  const ideasOnly = ideasOnlySourceProblem(input.source)
  if (ideasOnly) { tried.push(`ideas-only: ${ideasOnly}`); return base("unavailable", false, ideasOnly, vendor !== "internal" && vendor !== "osint") }
  if (rights.rights === "unknown" || vendor === null) {
    return base("unavailable", false, `no vendor contract names ${input.source} — its rights basis is unknown and is never guessed (fail closed)`, true)
  }
  if (vendor === "internal") return withValue(base("first_party", true, "first-party — the tenant's own data, no vendor call, no spend", false, { maxSpendUsd: 0 }))
  const paid = vendor !== "osint"

  // 0. RIGHTS BEFORE ANY APPROVAL (wave 153, lane 153T — Datafiniti wired into this door). A vendor the route table holds
  // dormant_pending_rights (PROVIDER_ACTIVATION, R9) is LICENSE-HELD: an approved plan line is the tenant's spend approval,
  // never the platform's licensing decision, so it must not open the door either. Before this, a plan line naming such a
  // source returned approved_plan while the platform door beside it said "pending rights". The caller's platform facts carry
  // the activation (pooled-pull.ts platformProviderDoorFacts); without facts for this vendor the rule cannot see it, and the
  // producer's own rights gate (datafiniti-people-producer.ts step 1) still refuses first.
  const facts = input.platform
  if (paid && facts && facts.vendor === vendor && facts.activation === "dormant_pending_rights") {
    tried.push(`rights: ${vendor} is dormant pending rights (PROVIDER_ACTIVATION, owner ruling R9)`)
    return base("unavailable", false, `LICENSE-HELD — ${vendor} is dormant pending rights; no approved plan line, platform connection or tenant connection opens ${input.source} until the owner records the licensing decision (R9)`, true)
  }

  // 1. An approved plan line (wave 150's rule, kept).
  const plan = approvedPlanLine(input.plans, { brokerageId: input.brokerageId, source: input.source }, now)
  if (plan.allowed) return withValue(base("approved_plan", true, `approved acquisition plan ${plan.planId} names ${input.source}`, paid, plan))
  tried.push(`approved plan: ${plan.reason}`)

  if (paid) {
    // 2. The platform's own connection.
    const pf = input.platform
    if (!pf) tried.push(`platform provider ${vendor}: no connection facts supplied by the caller`)
    else if (pf.vendor !== vendor) tried.push(`platform provider: facts describe ${pf.vendor}, not ${vendor}`)
    else if (!pf.configured) tried.push(`platform provider ${vendor}: not configured (${pf.credentialNames.length ? `${pf.credentialNames.join(" / ")} absent by name` : "no credential name is declared"})`)
    else if (pf.activation === "dormant_pending_rights") tried.push(`platform provider ${vendor}: dormant pending rights — never live until activation (owner ruling R9)`)
    else if (pf.activation === "dormant_survivor" && pf.survivorDoors === "closed") tried.push(`platform provider ${vendor}: the owner closed the survivor's live doors (OWNER-SQL §L L6.5)`)
    else if (!input.brokerageId) tried.push(`platform provider ${vendor}: a platform-pool territory has no tenant budget to fund it (OWNER-SQL §L L6.7 — owner decision pending)`)
    else if (pf.monthlyBudgetUsd === null || pf.remainingBudgetUsd === null) tried.push(`platform provider ${vendor}: no monthly budget ceiling is known for this territory — a paid pull needs a ceiling (fail closed)`)
    else if (pf.remainingBudgetUsd <= 0) tried.push(`platform provider ${vendor}: the territory's monthly budget is spent ($${pf.monthlyBudgetUsd})`)
    else {
      const cap = typeof pf.platformCapUsd === "number" ? Math.min(pf.monthlyBudgetUsd, pf.platformCapUsd) : pf.monthlyBudgetUsd
      return withValue(base("platform_provider", true,
        `platform-connected ${vendor} (${rights.rights}, ${rights.licence}) within the territory's monthly budget — $${Math.round(pf.remainingBudgetUsd * 100) / 100} of $${pf.monthlyBudgetUsd} left this month`,
        true, { maxSpendUsd: cap, approvedAt: monthStartIso(now), planId: `door:platform_provider:${vendor}` }))
    }
    // 3. A tenant-owned connection.
    const tn = input.tenant
    if (!tn) tried.push(`tenant-owned provider ${vendor}: no connection facts supplied (no acquisition vendor is tenant-connectable today — lib/connections/scope.ts CONNECTOR_PROVIDERS)`)
    else if (tn.vendor !== vendor) tried.push(`tenant-owned provider: facts describe ${tn.vendor}, not ${vendor}`)
    else if (tn.status === "unreadable") tried.push(`tenant-owned provider ${vendor}: the connection store could not be read${tn.detail ? ` (${tn.detail})` : ""} — refused, never substituted`)
    else if (tn.status === "not_connected") tried.push(`tenant-owned provider ${vendor}: not connected`)
    else if (!tn.healthy) tried.push(`tenant-owned provider ${vendor}: connected but failing (cool-down)`)
    else if (!tn.authorized) tried.push(`tenant-owned provider ${vendor}: connected but the tenant has not authorized acquisition use`)
    else {
      const ceiling = input.platform?.monthlyBudgetUsd ?? null
      return withValue(base("tenant_provider", true, `the tenant's own ${vendor} connection (healthy, authorized) — the tenant's account pays; the territory budget bounds the records`, true,
        { maxSpendUsd: ceiling, approvedAt: monthStartIso(now), planId: `door:tenant_provider:${vendor}` }))
    }
    return base("unavailable", false, `provider unavailable for ${input.source} — ${tried.join(" · ")}`, true)
  }
  // 4. A keyless public source (OSINT public records) — rights named, no vendor bill.
  return withValue(base("public_source", true, `permissible public source (${rights.rights}, ${rights.licence}) — no vendor cost`, false, { maxSpendUsd: 0 }))
}

/**
 * PURE — THE PAID-CALL GATE. May the tenant's share of a paid pull from `source` be bought? Without a door context this is
 * the wave-150 rule unchanged (an APPROVED, unexpired plan line of THAT tenant; an unreadable store refuses everyone — CLAUDE.md
 * §4). With a door context (the cron and the pooled lane pass the platform's connection facts) it is the IF / THEN above:
 * approved plan OR a configured, licensed platform provider within budget OR a healthy authorized tenant connection — and a
 * REAL unavailable otherwise.
 */
export function paidPullApproval(
  plans: readonly StoredPlanRow[] | null,
  want: { brokerageId: string | null; source: string },
  now: Date = new Date(),
  door?: SourceDoorContext,
): { allowed: true; planId: string; maxSpendUsd: number | null; approvedAt: string | null; door?: SourceDoor } | { allowed: false; reason: string; door?: SourceDoor } {
  if (!door) return approvedPlanLine(plans, want, now)
  const v = resolveSourceDoor({ source: want.source, brokerageId: want.brokerageId, plans, platform: door.platform ?? null, tenant: door.tenant ?? null, value: door.value ?? null, now })
  if (!v.allowed) return { allowed: false, reason: v.reason, door: v.door }
  return { allowed: true, planId: v.planId ?? `door:${v.door}`, maxSpendUsd: v.maxSpendUsd, approvedAt: v.approvedAt, door: v.door }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE INTELLIGENCE SOURCE LADDER — ONE SELECTOR (wave 155, lane 155H — directive H1 / H2 / H4, owner ruling R12)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Owner: "ai can also do searches for popular trends/people posts … creative and safe reasonable ways to collect data and hot
// topics … keeping in mind our roadblocks." The answer is a CHEAPEST-TRUTHFUL-SOURCE ladder, decided here and nowhere else
// (an extension of this planner, not a second one). PURE — no client, no network, no credential: a caller states each
// candidate's facts (status, rights, fields, territory, age, cost, rate limit, overlap) and this picks the lowest rung that is
// allowed and fit for the outcome, saying for every other candidate why it was not used.
//
// THREE SOURCE CLASSES, THREE ALLOWED OUTCOMES (H1) — enforced below, not described:
//   · idea            → the topic pool ONLY (public chatter, Facebook group topics, Meta Ad Library themes, competitor
//                        content, Reddit, trends). Never a Raw Lead.
//   · acquisition     → the canonical RawData → Raw Lead path ONLY (consented first-party inquiry, a licensed person
//                        dataset, a self-identified public person through path B). Never the topic pool as a lead surrogate.
//   · market_evidence → education / search, and the topic pool for an education piece (permitted public records, licensed
//                        property / sold data, confirmed local events). Anonymous aggregate interest is never a person.
// A PAID candidate is never chosen without license + approval (`paidApproved`) — the selector then authorizes ZERO paid calls,
// and an unknown cost is never read as free.

export type IntelligenceSourceClass = "idea" | "acquisition" | "market_evidence"
export type IntelligenceOutcome = "topic_pool" | "raw_data" | "education_search"

const INTELLIGENCE_CLASS_OUTCOMES: Readonly<Record<IntelligenceSourceClass, readonly IntelligenceOutcome[]>> = Object.freeze({
  idea: ["topic_pool"],
  acquisition: ["raw_data"],
  market_evidence: ["education_search", "topic_pool"],
})

/** The ladder, cheapest truthful source first. The index IS the preference order. */
export const INTELLIGENCE_LADDER = [
  "cached_verified",  // a verified record already held — no call at all
  "first_party",      // questions / consented signals already arriving: website chat, portal, appointments, saved-home patterns
  "public_fact",      // accessible public government facts, verified market data, independently confirmed local events
  "search_demand",    // aggregate (anonymous) search interest — Trends / Search Console / first-party demand
  "public_chatter",   // public posts and questions — IDEAS ONLY
  "grounded_person",  // a self-identified public person stating their own need — the gated RawData path B only
  "licensed_dataset", // paid structured data — a COUNTED gap-filler, after everything free
  "costly_scrape",    // a duplicate scrape — last
] as const
export type IntelligenceRung = (typeof INTELLIGENCE_LADDER)[number]

/** Which classes a rung may serve (a public post can never be an acquisition source; a grounded person never a topic). */
const RUNG_CLASSES: Readonly<Record<IntelligenceRung, readonly IntelligenceSourceClass[]>> = Object.freeze({
  cached_verified: ["idea", "acquisition", "market_evidence"],
  first_party: ["idea", "acquisition", "market_evidence"],
  public_fact: ["market_evidence"],
  search_demand: ["idea", "market_evidence"],
  public_chatter: ["idea"],
  grounded_person: ["acquisition"],
  licensed_dataset: ["acquisition", "market_evidence"],
  costly_scrape: ["idea", "acquisition", "market_evidence"],
})

/** A paid candidate whose records overlap what is already held by at least this ratio is not bought (a stated policy line,
 *  not a measurement: nine in ten already held means the pull mostly re-buys). Measured overlap only — unknown is not assumed. */
const LADDER_MAX_PAID_OVERLAP = 0.9

export interface IntelligenceSourceCandidate {
  key: string
  rung: IntelligenceRung
  sourceClass: IntelligenceSourceClass
  status: "available" | "not_connected" | "owner_held" | "license_held" | "refused"
  rights: "licensed" | "first_party" | "public_record" | "public_read_reworded" | "public_citation" | "unknown"
  /** The fields this source can supply; null = unknown (a paid source is never bought to find out). */
  fieldsAvailable: readonly string[] | null
  /** Does the source cover the tenant's authorized territory? null = unknown. */
  territoryCovered: boolean | null
  /** Age of the newest event / record the source would supply, in days; null = unknown. */
  eventAgeDays: number | null
  /** The freshness window this outcome tolerates for this source, in days; null = no window stated. */
  maxAgeDays: number | null
  /** Estimated total cost in USD (provider + enrichment + AI); null = unknown (never read as 0). */
  estimatedCostUsd: number | null
  paid: boolean
  /** Calls left in the source's rate-limit window; null = unknown. */
  rateLimitRemaining: number | null
  /** Measured share of the records already held (pre-pull dedup); null = unknown. */
  dedupOverlapRatio: number | null
  /** A private group / sign-in page — never read, under any class. */
  privateSource?: boolean
  /** THE pre-pull value verdict for a paid candidate, when evaluated (pre-pull-value.ts); a hold / refuse closes it. */
  value?: PrePullValueVerdict | null
}

export interface IntelligenceNeed {
  outcome: IntelligenceOutcome
  neededFields?: readonly string[]
  budgetUsd: number | null
  /** License recorded AND a spend approval exists (an approved plan line or a door with a ceiling). False → zero paid calls. */
  paidApproved: boolean
}

export interface LadderTrailEntry { key: string; rung: IntelligenceRung; verdict: "chosen" | "eligible" | "deferred" | "refused"; why: string }

export interface LadderChoice {
  chosen: IntelligenceSourceCandidate | null
  trail: LadderTrailEntry[]
  /** 1 only when the chosen candidate is paid and approved; the caller's paid seam is counted against this. */
  paidCallsAuthorized: number
  reason: string
}

/** PURE — one candidate against one need: null when eligible, else the refusal; a "defer:" prefix = eligible later. */
function ladderProblem(c: IntelligenceSourceCandidate, need: IntelligenceNeed): string | null {
  if (c.privateSource) return "a private group or sign-in page — never read (no fetch is made)"
  if (!INTELLIGENCE_CLASS_OUTCOMES[c.sourceClass].includes(need.outcome)) return `a ${c.sourceClass} source may feed ${INTELLIGENCE_CLASS_OUTCOMES[c.sourceClass].join(" / ")}, never ${need.outcome}`
  if (!RUNG_CLASSES[c.rung].includes(c.sourceClass)) return `the ${c.rung} rung cannot serve the ${c.sourceClass} class`
  if (need.outcome === "raw_data") { const io = ideasOnlySourceProblem(c.key); if (io) return io }
  if (c.status !== "available") return c.status === "license_held" ? "LICENSE-HELD — no rights on record" : c.status === "owner_held" ? "OWNER-HELD" : c.status === "not_connected" ? "not connected" : "refused by its own gate"
  if (c.rights === "unknown") return "rights unknown — never guessed"
  if (c.territoryCovered === false) return "outside the tenant's authorized territory"
  if (c.territoryCovered === null && need.outcome === "raw_data") return "territory coverage unknown — a person record needs a territory"
  if (c.eventAgeDays !== null && c.maxAgeDays !== null && c.eventAgeDays > c.maxAgeDays) return `stale — ${c.eventAgeDays} days old against a ${c.maxAgeDays}-day window`
  if (c.eventAgeDays === null && need.outcome === "raw_data") return "record age unknown — a person's need is current only with a date"
  const needed = need.neededFields ?? []
  if (needed.length) {
    if (c.fieldsAvailable === null) { if (c.paid) return `field availability unknown — never paid for to find out (${needed.join(", ")})` }
    else { const missing = needed.filter((f) => !c.fieldsAvailable!.includes(f)); if (missing.length) return `does not supply ${missing.join(", ")}` }
  }
  if (c.paid) {
    if (!need.paidApproved) return "paid source without license + approval — 0 paid calls authorized"
    if (c.estimatedCostUsd === null) return "estimated cost unknown — an unknown cost is not zero"
    if (need.budgetUsd === null) return "no budget ceiling recorded — a paid pull needs one"
    if (c.estimatedCostUsd > need.budgetUsd) return `$${c.estimatedCostUsd} exceeds the $${need.budgetUsd} ceiling`
    if (c.dedupOverlapRatio !== null && c.dedupOverlapRatio >= LADDER_MAX_PAID_OVERLAP) return `${Math.round(c.dedupOverlapRatio * 100)}% of its records are already held — the pull would mostly re-buy`
    const why = c.value ? prePullRefusal(c.value) : null
    if (why) return `the pre-pull value formula refuses — ${why}`
  }
  if (c.rateLimitRemaining !== null && c.rateLimitRemaining <= 0) return "defer: rate limit exhausted for this window"
  return null
}

/**
 * PURE — THE SELECTOR. The lowest eligible rung wins; within a rung, the lower known cost (a free candidate before a costed
 * one). Every candidate gets a trail line. Nothing is called here; `paidCallsAuthorized` is what the caller's paid seam may
 * spend against (0 unless the chosen candidate is paid and approved).
 */
export function chooseIntelligenceSource(need: IntelligenceNeed, candidates: readonly IntelligenceSourceCandidate[]): LadderChoice {
  const trail: LadderTrailEntry[] = []
  const eligible: IntelligenceSourceCandidate[] = []
  for (const c of candidates) {
    const p = ladderProblem(c, need)
    if (p === null) { eligible.push(c); continue }
    trail.push({ key: c.key, rung: c.rung, verdict: p.startsWith("defer:") ? "deferred" : "refused", why: p.replace(/^defer:\s*/, "") })
  }
  const rank = (c: IntelligenceSourceCandidate) => INTELLIGENCE_LADDER.indexOf(c.rung)
  const cost = (c: IntelligenceSourceCandidate) => (c.paid ? c.estimatedCostUsd ?? Number.POSITIVE_INFINITY : 0)
  eligible.sort((a, b) => rank(a) - rank(b) || cost(a) - cost(b))
  const chosen = eligible[0] ?? null
  for (const c of eligible) trail.push({ key: c.key, rung: c.rung, verdict: c === chosen ? "chosen" : "eligible", why: c === chosen ? `lowest eligible rung (${c.rung})${c.paid ? ` — paid, approved, $${c.estimatedCostUsd}` : " — no spend"}` : `eligible, but ${chosen!.rung} is cheaper on the ladder` })
  return {
    chosen, trail, paidCallsAuthorized: chosen && chosen.paid ? 1 : 0,
    reason: chosen ? `${chosen.key} (${chosen.rung}) for ${need.outcome}` : `no source is eligible for ${need.outcome} — ${trail.map((t) => `${t.key}: ${t.why}`).join(" · ") || "no candidates"}`,
  }
}

/**
 * THE LICENSED-DATASET SEAM (lane 155I requests its selector rows here — Datafiniti's people / property / business / product
 * datasets, and any other licensed provider). A provider row becomes a ladder candidate on the licensed_dataset rung; dormant
 * pending rights or no rights record → license_held (zero calls); unit price × records when both are known, else unknown.
 */
export interface LicensedDatasetSelectorRow {
  provider: string
  dataset: string
  sourceClass: Extract<IntelligenceSourceClass, "acquisition" | "market_evidence">
  activation: PlatformProviderDoor["activation"]
  rightsRecorded: boolean
  fields: readonly string[] | null
  unitUsd: number | null
  records: number | null
  territoryCovered: boolean | null
  eventAgeDays?: number | null
  maxAgeDays?: number | null
  dedupOverlapRatio?: number | null
  rateLimitRemaining?: number | null
}

/**
 * THE DATAFINITI ROWS ON THE PAID RUNG (lane 155I's carry-in). Datafiniti property / business / product are dataset NEEDS
 * decided by 155I's own door (schema → count → overlap → approval), never acquisition SourceKeys; people stays
 * `datafiniti_people` with no acquisition play. The rows reach this ladder ONLY through this seam, bound by the integrator to
 * lib/lead-pipeline/datafiniti-dataset-door.ts datafinitiDatasetSelection. Unbound (null) → no Datafiniti candidate at all.
 */
export type DatafinitiDatasetSeam = () => ReadonlyArray<{ dataset: string; role: string; licenseHeld: boolean }>
/** Production binding — null until the integrator binds it (the exact line is in lane 155H's notes). */
// BOUND (wave 155, at merge of lanes 155H + 155I): the ladder reads the ONE dataset selection (lib/lead-pipeline/datafiniti-dataset-door.ts).
// Every row is license-held today, so none is spendable — the rule is asserted by test:intelligence-brief on whatever this returns.
export const PRODUCTION_DATAFINITI_DATASET_SEAM: DatafinitiDatasetSeam | null = () => datafinitiDatasetSelection().map((r) => ({ dataset: r.dataType, role: r.selection, licenseHeld: r.licenseHeld }))

/** PURE — the seam's rows as ladder candidates. A licenseHeld row is license_held (NO spend is ever offered); a row its door
 *  calls not_needed / dormant is refused here; a conditional row is available with an UNKNOWN cost, so the ladder never buys it
 *  until 155I's door supplies a count and a quote. */
/** @ownerRuled 2026-11-19 owner R11: Datafiniti is LICENSE-HELD, no paid call without license + approval; no product decision reads this seam until a license is recorded (lane 155R25) */
export function datafinitiLadderCandidates(seam: DatafinitiDatasetSeam | null = PRODUCTION_DATAFINITI_DATASET_SEAM): IntelligenceSourceCandidate[] {
  if (!seam) return []
  return seam().map((r) => ({
    key: `datafiniti:${r.dataset}`, rung: "licensed_dataset" as const, sourceClass: r.dataset === "people" ? "acquisition" as const : "market_evidence" as const,
    status: r.licenseHeld ? "license_held" as const : r.role === "conditional_gap_fill" ? "available" as const : "refused" as const,
    rights: r.licenseHeld ? "unknown" as const : "licensed" as const, fieldsAvailable: null, territoryCovered: null, eventAgeDays: null, maxAgeDays: null,
    estimatedCostUsd: null, paid: true, rateLimitRemaining: null, dedupOverlapRatio: null,
  }))
}

/** PURE — the Datafiniti rows that may be offered ANY spend (never a licenseHeld row). Today all four are license-held → []. */
/** @ownerRuled 2026-11-19 owner R11: Datafiniti is LICENSE-HELD, no paid call without license + approval; every row is license-held, so no spend decision reads this until a license is recorded (lane 155R25) */
export function spendableDatafinitiRows(seam: DatafinitiDatasetSeam | null = PRODUCTION_DATAFINITI_DATASET_SEAM): string[] {
  return seam ? seam().filter((r) => !r.licenseHeld).map((r) => r.dataset) : []
}

/** @ownerRuled 2026-11-19 owner R11: the licensed-dataset rung's row mapper; Datafiniti, its one provider, is LICENSE-HELD (no paid call without license + approval), so nothing builds a row until a license is recorded (lane 155R25) */
export function licensedDatasetCandidate(row: LicensedDatasetSelectorRow): IntelligenceSourceCandidate {
  const held = row.activation === "dormant_pending_rights" || !row.rightsRecorded
  return {
    key: `${row.provider}:${row.dataset}`, rung: "licensed_dataset", sourceClass: row.sourceClass,
    status: held ? "license_held" : row.activation === "active" ? "available" : "not_connected",
    rights: held ? "unknown" : "licensed", fieldsAvailable: row.fields, territoryCovered: row.territoryCovered,
    eventAgeDays: row.eventAgeDays ?? null, maxAgeDays: row.maxAgeDays ?? null,
    estimatedCostUsd: row.unitUsd !== null && row.records !== null ? Math.round(row.unitUsd * row.records * 100) / 100 : null,
    paid: true, rateLimitRemaining: row.rateLimitRemaining ?? null, dedupOverlapRatio: row.dedupOverlapRatio ?? null,
  }
}
