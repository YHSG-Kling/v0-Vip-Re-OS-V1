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

import { SOURCE_MAP, SOURCE_VENDOR, SOURCE_PAID_PERSON_DATA, sourceRightsFor, type SourceKey } from "./source-intent-map"
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

/** `held` (wave 151, lane 151C): the pre-pull value formula held the line — never approvable, re-preview first. */
type PlanLineStatus = "free_ready" | "proposed" | "needs_preview" | "needs_quote" | "over_budget" | "blocked_rights" | "held" | "approved"

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
    if (rights === "unknown") { line.status = "blocked_rights"; line.why = "no rights basis names this source" }
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

  if (rights.rights === "unknown" || vendor === null) {
    return base("unavailable", false, `no vendor contract names ${input.source} — its rights basis is unknown and is never guessed (fail closed)`, true)
  }
  if (vendor === "internal") return withValue(base("first_party", true, "first-party — the tenant's own data, no vendor call, no spend", false, { maxSpendUsd: 0 }))
  const paid = vendor !== "osint"

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
        `platform-connected ${vendor} (${rights.rights}, ${rights.license}) within the territory's monthly budget — $${Math.round(pf.remainingBudgetUsd * 100) / 100} of $${pf.monthlyBudgetUsd} left this month`,
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
  return withValue(base("public_source", true, `permissible public source (${rights.rights}, ${rights.license}) — no vendor cost`, false, { maxSpendUsd: 0 }))
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
