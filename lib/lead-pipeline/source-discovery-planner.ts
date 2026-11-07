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

import { SOURCE_MAP, SOURCE_VENDOR, sourceRightsFor, type SourceKey } from "./source-intent-map"
import { SOURCE_ACQUISITION } from "./acquisition-coverage"
// The REI Playbook v5.5 method has ONE home (wave 150, lane 150KLMO): the investor buy-box criteria and the hunting/farming
// reading come from lib/investor/rei-playbook.ts investorPlay — the two inline literals this planner carried are merged there.
import { investorPlay } from "@/lib/investor/rei-playbook"

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

/** What this territory's own history says about one source (read from raw_scraped_leads, never estimated). */
export interface SourceHistory { rawRows: number; promoted: number; duplicates: number; costUsd: number }

/** A FREE preview count (a provider's count / purchase=0 endpoint, or a first-party table count). */
export interface SourcePreview { count: number; at: string; via: string }

/** A price per record from a quote or the catalogue — never a guess. */
export interface SourceQuote { unitUsd: number; minimumUsd?: number | null; basis: "provider_quote" | "catalogue" | "history" }

type PlanLineStatus = "free_ready" | "proposed" | "needs_preview" | "needs_quote" | "over_budget" | "blocked_rights" | "approved"

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

const SOURCE_DISCOVERY_PLANNER_VERSION = "source-discovery@1"

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
}): AcquisitionPlan {
  const blindSpots: string[] = []
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
    const line: PlanLine = {
      source, plays: SOURCE_PLAYS[source], side: sideOf(source), vendor, rights, paid,
      previewCount: p?.count ?? null, previewVia: p?.via ?? null, estimatedReach: reach,
      quoteUsd: quote, quoteBasis: paid ? q?.basis ?? null : null,
      expectedNewLeads: expected, expectedBasis: ratio !== null ? "territory_history" : "no_history",
      costPerExpectedLead: paid && quote !== null && expected && expected > 0 ? Math.round((quote / expected) * 100) / 100 : null,
      criteria: investor && buyBox.ok && buyBox.kind === "play"
        ? { equityPercentMin: buyBox.equityPercentMin, note: "buy-box overlay — investor plays only (REI Playbook v5.5, a labelled heuristic)", preview: buyBox.preview, unconfirmed: buyBox.unconfirmed }
        : null,
      status: "proposed", why: "",
    }
    if (rights === "unknown") { line.status = "blocked_rights"; line.why = "no rights basis names this source" }
    else if (!paid) { line.status = "free_ready"; line.why = "first-party — the tenant's own data, no vendor call, no spend" }
    else if (reach === null) { line.status = "needs_preview"; line.why = "no free preview count and no history — nothing to show before buying" }
    else if (quote === null) { line.status = "needs_quote"; line.why = "no quote / catalogue price for this source" }
    return line
  })

  // Paid candidates, ranked: known cost per expected lead first (cheapest), the market-favoured side weighted 20 %.
  const weight = (l: PlanLine) => {
    const base = l.costPerExpectedLead ?? Number.POSITIVE_INFINITY
    const favoured = tilt !== "balanced" && (l.side === tilt || l.side === "both")
    return favoured ? base * 0.8 : base
  }
  const candidates = lines.filter((l) => l.status === "proposed").sort((a, b) => weight(a) - weight(b) || (a.quoteUsd ?? 0) - (b.quoteUsd ?? 0))
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
    if (keep.has(l)) { l.why = `preview ${l.estimatedReach} × quote $${l.quoteUsd}${l.costPerExpectedLead !== null ? ` ≈ $${l.costPerExpectedLead} per expected new lead (observed)` : " — no history to estimate new leads"}` }
    else { l.status = "over_budget"; l.why = `$${l.quoteUsd} does not fit the remaining budget` }
  }
  if (marketMode === "farming") {
    for (const l of lines) if (l.plays.includes("owner_equity") && l.status === "proposed") l.why += " · farming market: distress counts are thin — the first-party and guidance plays lead"
  }
  const chosen = lines.filter((l) => l.status === "proposed" || l.status === "free_ready")
  if (!chosen.some((l) => l.side !== "seller")) blindSpots.push("no buyer-side line could be planned")
  if (!chosen.some((l) => l.side !== "buyer")) blindSpots.push("no seller-side line could be planned")
  blindSpots.push("expected new leads are this territory's own observed promotion ratio — a source never run here has none")
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

/**
 * PURE — THE PAID-CALL GATE. May the tenant's share of a paid pull from `source` be bought? Only under an APPROVED,
 * unexpired plan of THAT tenant that approved THAT source. Anything else — no plan, a proposal, an expired approval, an
 * unreadable plan store (the caller passes `null`) — refuses (CLAUDE.md §4: a gate that cannot run must refuse).
 */
export function paidPullApproval(
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
