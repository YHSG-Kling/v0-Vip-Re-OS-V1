// lib/kernel/brokerage-twin.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE BROKERAGE DIGITAL TWIN (wave 104, lane 104B) — ONE derived operating representation of a
// tenant: what is happening NOW, what CHANGED since the last snapshot, what is AT RISK, what
// CAPACITY exists, what OBJECTIVES are active, what ECONOMIC state exists — every conclusion
// carrying an EVIDENCE REF (table + filter + count + the module that produced the number).
//
// SURVIVORS EVALUATED (none answered the whole question; each answers ONE slice, and the twin
// READS them rather than re-deriving):
//   · lib/kernel/intelligence-report.ts — the MONTHLY owner report (drafts / autonomy /
//     attribution / activity / trust). Month-windowed facts, not a present-state model.
//   · lib/intelligence/derived-snapshots.ts — nightly property_smart_insights + team heatmap
//     (per-listing DOM, per-ZIP activity). Property-grain, not tenant-grain.
//   · lib/kernel/morning-standup.ts / steer-my-day.ts — AGENT-scoped day ranking.
//   · lib/intelligence/manager-weekly-exec-plan.ts — the weekly ranked org plan OVER boards
//     (retention / P&L / backlog). A ranking pass; it now READS the twin (inputs.twin).
//   · lib/brokerage-intelligence/miners.ts mineAllPatterns — top-vs-bottom quartile patterns
//     (brokerage_intelligence_insights). Learning, not state.
//   · territory_metrics / revenue_protection_snapshots — ZIP economics and protected-GCI
//     snapshots (own chain of previous_snapshot_id). Slices the twin cites, not the whole.
//   · capacityFor (103B, lib/lead-assignment/capacity-pick.ts) — THE agent capacity answer; the
//     twin calls it per active agent, never re-derives a band.
//   · deal_health_scores / listing_health_scores / manager_signals(*_stall_predicted) /
//     buyer_fatigue_scores / agent_retention_scores / compliance_flags — the existing predictors'
//     OUTPUT tables. The twin reads outputs; it makes NO new prediction.
//   · income_forecast_snapshots (lib/income-forecast/forecaster.ts) — projected pipeline value.
//   · ai_tool_usage — the AI cost ledger (CLAUDE.md §5); agent_commissions / transactions —
//     closed GCI; lib/intelligence/roi-ledger.ts — attribution (read by the Command Center
//     beside the twin, not duplicated here).
//
// SNAPSHOTS: no survivor table fits a whole-twin row (revenue_protection_snapshots has a closed
// snapshot_type CHECK and NOT NULL money columns; brokerage_intelligence_insights is a mined
// pattern; income_forecast_snapshots is per agent), so m708 adds brokerage_twin_snapshots
// (brokerage_id, team_id, at, twin jsonb, previous_snapshot_id, digest). Until it is applied the
// twin still builds — `changed.baseline` is true and `persist.error` names the refusal.
//
// SCENARIO FOUNDATION: `scenario(twin, deltas)` is PURE and recomputes DERIVED fields only —
// capacity through computeCapacity (the same math capacityFor uses), projected pipeline value by
// scaling the income forecaster's own output, AI cost by scaling the meter. Every output names
// its inputs and the predictor it reused; a question the twin cannot answer returns
// status "unsupported" — never a number.
//
// OBJECTIVE DECOMPOSITION: `decomposeObjective` maps an agent_goals-vocabulary objective to
// measurable sub-targets, each naming the twin field that measures it (feeds 104D missions).
//
// SEAMS (lazy, degrade cleanly): registerTwinSeam("contributionMargin", fn) is where 104A's
// lib/kernel/economic-graph.ts plugs in; registerTwinSeam("missions", fn) is where 104D's mission
// runtime plugs in. Absent → economic.contributionMargin.status "unavailable" /
// objectives.missions.status "none". WIRED (lane 104F): each module registers its seam AT MODULE
// LOAD (economic-graph.ts / missions.ts, bottom of file); the Command Center's twin build
// (lib/kernel/command-center.ts) lazy-imports both before buildBrokerageTwin so the registration
// has happened — a module that fails to load leaves the seam absent and the twin degrades.
//
// Tenancy: every read is pinned to brokerageId (the caller resolves it from the SESSION — the
// Command Center's resolveTenantScope; teams see only their board through teamId → agents.team_id).
// NOT server-only (the proof drives the pure halves and the loader through an in-memory client).

import { AGENT_GOAL_TYPES, isAgentGoalType, type AgentGoalType } from "@/lib/goals/goal-types"
import {
  computeCapacity, tierMaxLoadForAgentCount, CAPACITY_BANDS,
  type CapacityBand, type WorkloadSignals,
} from "@/lib/kernel/capacity-guardian"
import { TRANSACTION_STATUSES_OPEN, TRANSACTION_STATUSES_IN_ESCROW } from "@/lib/transactions/transaction-status"

type Svc = { from: (table: string) => any }

// ─── Evidence ────────────────────────────────────────────────────────────────

/** One evidence reference: the table and filter a conclusion was read from, how many rows
 *  backed it, and the module (predictor / scorer / meter) that produced the number. */
export interface EvidenceRef {
  table: string
  filter: string
  count: number
  /** The producer of the rows (the predictor / scorer / ledger writer), never the twin itself. */
  via: string
  /** The first ids backing the conclusion (bounded) — a reviewer can open them. */
  ids?: string[]
}

// ─── Twin shape ──────────────────────────────────────────────────────────────

export interface TwinNow {
  pipeline: {
    /** Active leads (brokerage-owned — CLAUDE.md §5). */
    leads: number
    byLifecycle: Record<string, number>
    /** Leads converted to a contact in the trailing 90 days. */
    converted90d: number
    evidence: EvidenceRef
  }
  contacts: { active: number; evidence: EvidenceRef }
  listings: { active: number; byStatus: Record<string, number>; evidence: EvidenceRef }
  transactions: {
    open: number
    inEscrow: number
    /** Sum of transactions.estimated_commission on open deals (cents). */
    openCommissionCents: number
    evidence: EvidenceRef
  }
}

export type TwinRiskKind = "deal_health" | "listing_health" | "stall" | "fatigue" | "compliance" | "retention"
export type TwinRiskSeverity = "watch" | "at_risk" | "critical"

export interface TwinRisk {
  kind: TwinRiskKind
  severity: TwinRiskSeverity
  count: number
  headline: string
  /** Open commission (cents) behind the risk when the rows carry one (deal health only); null otherwise. */
  exposureCents: number | null
  evidence: EvidenceRef
}

export interface TwinAgentCapacity {
  agentId: string
  band: CapacityBand
  load: number
  headroom: number
  followUpDebt: number
  fatigueTier: WorkloadSignals["fatigueTier"]
  reasons: string[]
}

export interface TwinCapacity {
  activeAgents: number
  /** The tier ceiling capacityFor used (tierMaxLoadForAgentCount). */
  maxLoad: number
  bands: Record<CapacityBand, number>
  /** Sum of per-agent headroom (items the roster can still take). */
  headroom: number
  perAgent: TwinAgentCapacity[]
  /** Agents the loader could not score (a refused read — never counted as "available"). */
  unscored: number
  evidence: EvidenceRef
}

export interface TwinObjective {
  id: string
  agentId: string | null
  goalType: string
  targetValue: number
  currentValue: number
  /** 0..100, null when the target is 0. */
  progressPct: number | null
}

export interface TwinObjectives {
  goals: TwinObjective[]
  /** strategy_recommendations awaiting a verdict. */
  strategyPending: number
  /** 104D seam: "none" until a mission runtime registers. */
  missions: { status: "none" | "present"; active: number; source: string }
  evidence: EvidenceRef[]
}

export interface TwinEconomic {
  /** Closed GCI in the trailing 90 days (transactions.commission_amount, status closed/funded), cents. */
  gciClosed90dCents: number
  closedCount90d: number
  /** Income forecaster output summed across agents' latest snapshots (weighted_90), cents; null = no snapshot. */
  projectedWeighted90Cents: number | null
  /** AI cost ledger, trailing 30 days (ai_tool_usage.cost_cents). */
  aiCost30dCents: number
  /** 104A seam: lib/kernel/economic-graph.ts contribution margin. */
  contributionMargin: { status: "unavailable" | "present"; cents: number | null; source: string }
  evidence: EvidenceRef[]
}

export interface TwinChange {
  field: string
  previous: number
  current: number
  delta: number
}

export interface TwinChanged {
  /** True when there is no prior snapshot to diff against (first build, or the table is absent). */
  baseline: boolean
  previousSnapshotId: string | null
  previousAt: string | null
  changes: TwinChange[]
  /** Why there is no baseline, when there is none. */
  reason: string | null
}

// ─── Workforce (wave 106, lane 106E) ─────────────────────────────────────────
//
// BROKERAGE WORKFORCE INTELLIGENCE — the OS knows of its 50 agents who is a strong listing / buyer /
// investor agent, who is bilingual, who is a luxury specialist, who is overwhelmed, who is
// underutilized, who is in development. ONE new twin section (snapshot-persisted with the rest),
// every classification carrying the READER that produced its evidence and the THRESHOLD it was
// judged against — the threshold comes from TENANT POLICY (brokerage_settings.settings
// .workforce_thresholds, registered in lib/kernel/tenant-policy.ts; defaults below), never a
// constant hidden in a composer. SURVIVORS READ, none re-derived: capacityFor (band + fatigue
// tier — the one capacity answer), loadAgentCompetency (the one competency reader; 106D widens
// its vocabulary and this section reads gaps through it, never restating the skill list),
// agents.languages / agents.specializations (the profile columns the people-ops profile writes),
// listings / offers / contacts.contact_persona (the m589 vocabulary: 'investor', 'luxury').
// TERRITORY DEMAND (the recruiting trigger): farm_territories (an agent's farm — the only
// territory model, m551/m715) × leads.property_zip_code — seller leads in the trailing 30 days
// against the 30 before, per territory; the serving agents' headroom and specialist coverage
// are the capacity and competency coverage a recruiting need is judged against (recruitingNeeds).

export type WorkforceClassification =
  | "strong_listing" | "strong_buyer" | "investor" | "bilingual" | "luxury_specialist"
  | "overwhelmed" | "underutilized" | "in_development"

export const WORKFORCE_CLASSIFICATIONS: readonly WorkforceClassification[] = [
  "strong_listing", "strong_buyer", "investor", "bilingual", "luxury_specialist", "overwhelmed", "underutilized", "in_development",
]

/** The tenant-policy key (brokerage_settings.settings) the thresholds are read from. */
export const WORKFORCE_THRESHOLDS_KEY = "workforce_thresholds"

export interface WorkforceThresholds {
  /** strong_listing: listings taken (listing_date) in the trailing 180 days, or active now. */
  strong_listing_listings_180d: number
  /** strong_buyer: buyer-side offers written in the trailing 180 days (offers.agent_id). */
  strong_buyer_offers_180d: number
  /** investor: active contacts at contact_persona='investor' on the agent's book. */
  investor_contacts: number
  /** bilingual: agents.languages entries. */
  bilingual_languages: number
  /** luxury: a listing at or above this list price is a luxury listing. */
  luxury_list_price_usd: number
  /** luxury_specialist: luxury listings taken in 180 days (or a 'luxury' entry in agents.specializations). */
  luxury_listings_180d: number
  /** overwhelmed: the capacity band at or beyond which an agent is overwhelmed (capacityFor folds the fatigue tier). */
  overwhelmed_band: "over" | "at_capacity"
  /** underutilized: band available AND load at or under this percentage of the tier ceiling. */
  underutilized_load_pct: number
  /** in_development: competency gaps (loadAgentCompetency) at or above this count. */
  in_development_gaps: number
  /** Territory demand is UP when seller leads 30d exceed the prior 30d by this percentage. */
  demand_rise_pct: number
  /** …and are at least this many (a rise from 1 to 2 is noise). */
  demand_min_leads_30d: number
  /** Seller leads one listing agent with headroom absorbs in 30 days (the capacity rule). */
  seller_leads_per_agent_30d: number
  /** A territory whose seller leads are this % luxury-priced needs a luxury specialist. */
  luxury_share_pct: number
}

export const DEFAULT_WORKFORCE_THRESHOLDS: WorkforceThresholds = {
  strong_listing_listings_180d: 3, strong_buyer_offers_180d: 3, investor_contacts: 3, bilingual_languages: 2,
  luxury_list_price_usd: 1_000_000, luxury_listings_180d: 2, overwhelmed_band: "over", underutilized_load_pct: 25,
  in_development_gaps: 1, demand_rise_pct: 25, demand_min_leads_30d: 5, seller_leads_per_agent_30d: 8, luxury_share_pct: 30,
}

/** PURE: the tenant's thresholds from the settings jsonb — every key validated, an absent or
 *  out-of-range value falls back to the default (never a NaN threshold). */
export function resolveWorkforceThresholds(settings: unknown): WorkforceThresholds {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>)[WORKFORCE_THRESHOLDS_KEY] : undefined
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const num = (k: keyof WorkforceThresholds, max: number): number => {
    const v = Number(obj[k])
    return Number.isFinite(v) && v >= 0 && v <= max ? v : (DEFAULT_WORKFORCE_THRESHOLDS[k] as number)
  }
  return {
    strong_listing_listings_180d: num("strong_listing_listings_180d", 1000), strong_buyer_offers_180d: num("strong_buyer_offers_180d", 1000),
    investor_contacts: num("investor_contacts", 10_000), bilingual_languages: num("bilingual_languages", 20),
    luxury_list_price_usd: num("luxury_list_price_usd", 1e9), luxury_listings_180d: num("luxury_listings_180d", 1000),
    overwhelmed_band: obj.overwhelmed_band === "at_capacity" ? "at_capacity" : "over",
    underutilized_load_pct: num("underutilized_load_pct", 100), in_development_gaps: num("in_development_gaps", 20),
    demand_rise_pct: num("demand_rise_pct", 10_000), demand_min_leads_30d: num("demand_min_leads_30d", 100_000),
    seller_leads_per_agent_30d: Math.max(1, num("seller_leads_per_agent_30d", 10_000)), luxury_share_pct: num("luxury_share_pct", 100),
  }
}

export interface WorkforceEvidence {
  /** The reader that produced the value (table.column + the module), never the twin itself. */
  reader: string
  value: number | string
  /** The policy threshold the value was judged against. */
  threshold: number | string
}

export interface WorkforceClassified {
  kind: WorkforceClassification
  evidence: WorkforceEvidence
  reason: string
}

export interface WorkforceAgentProfile {
  agentId: string
  classifications: WorkforceClassified[]
  /** The per-agent facts behind the classifications (a reviewer sees the counts, not only the verdict). */
  facts: WorkforceAgentFacts
}

export interface WorkforceAgentFacts {
  agentId: string
  userId: string | null
  languages: string[]
  specializations: string[]
  listings180d: number
  luxuryListings180d: number
  offers180d: number
  investorContacts: number
  /** From loadAgentCompetency; null = the reader was not run / refused for this agent. */
  competencyGaps: number | null
  competencyRefused: string | null
}

export interface TwinTerritoryDemand {
  /** farm_territories.name (one territory may be several agents' farms); "unassigned" = zips no farm covers. */
  territory: string
  zips: string[]
  servingAgentIds: string[]
  sellerLeads30d: number
  sellerLeadsPrev30d: number
  trend: "up" | "flat" | "down"
  /** 0..1 — share of the 30-day seller leads priced at or above luxury_list_price_usd (estimated_value). */
  luxuryShare30d: number
  /** Serving agents with headroom (band available / busy — the one capacity answer). */
  agentsWithHeadroom: number
  listingSpecialists: number
  luxurySpecialists: number
}

export interface TwinWorkforce {
  thresholds: WorkforceThresholds
  /** "policy" when brokerage_settings.workforce_thresholds carried a value, "default" otherwise. */
  thresholdsSource: "policy" | "default"
  agents: WorkforceAgentProfile[]
  totals: Record<WorkforceClassification, number>
  territories: TwinTerritoryDemand[]
  evidence: EvidenceRef[]
}

export interface RecruitingNeed {
  territory: string
  specialization: "listing" | "luxury"
  count: number
  reasons: string[]
  zips: string[]
}

export interface BrokerageTwin {
  brokerageId: string
  teamId: string | null
  /** The instant the twin describes (ISO). */
  at: string
  now: TwinNow
  changed: TwinChanged
  atRisk: TwinRisk[]
  capacity: TwinCapacity
  objectives: TwinObjectives
  economic: TwinEconomic
  /** Wave 106E — the workforce profile + territory demand (classified, evidence + policy threshold on each). */
  workforce: TwinWorkforce
  /** Named limits of this build (row caps, refused reads) — published beside the numbers. */
  blindSpots: string[]
  /** A stable digest of the measures (change detection + dedupe). */
  digest: string
}

// ─── Facts (what the loader reads; what the composer folds) ─────────────────

export interface TwinFacts {
  brokerageId: string
  teamId: string | null
  at: string
  leads: Array<{ id: string; lifecycle_state: string | null }>
  /** Leads converted (converted_at) in the trailing 90 days — a head count, active or not. */
  converted90d: number
  contactsActive: number
  listings: Array<{ id: string; status: string | null }>
  transactions: Array<{ id: string; status: string | null; estimated_commission: number | null }>
  closed90d: Array<{ id: string; commission_amount: number | null }>
  dealHealth: Array<{ transaction_id: string; risk_level: string | null; scored_at: string }>
  listingHealth: Array<{ listing_id: string; risk_level: string | null; scored_at: string }>
  stallSignals: Array<{ id: string; signal_type: string; entity_id: string | null }>
  fatigue: Array<{ contact_id: string; risk_level: string | null }>
  retention: Array<{ agent_id: string; tier: string | null; score_date: string }>
  complianceOpen: Array<{ id: string; severity: string | null }>
  goals: Array<{ id: string; agent_id: string | null; goal_type: string; target_value: number | null; current_value: number | null }>
  strategyPending: number
  capacity: { maxLoad: number; perAgent: TwinAgentCapacity[]; unscored: number; activeAgents: number }
  forecast: Array<{ agent_id: string; weighted_90: number | null }>
  aiCost30dCents: number
  contributionMargin: TwinEconomic["contributionMargin"]
  missions: TwinObjectives["missions"]
  previous: { id: string; at: string; measures: Record<string, number> } | null
  previousReason: string | null
  blindSpots: string[]
  /** Wave 106E — the workforce facts (per agent) + the territory demand inputs + the policy thresholds. */
  workforce: {
    thresholds: WorkforceThresholds
    thresholdsSource: TwinWorkforce["thresholdsSource"]
    agents: WorkforceAgentFacts[]
    farms: Array<{ name: string | null; zip_codes: string[] | null; agent_id: string | null }>
    /** Seller-side leads in the trailing 60 days (brokerage-owned — a territory fact, never team-narrowed). */
    sellerLeads60d: Array<{ id: string; property_zip_code: string | null; estimated_value: number | null; created_at: string }>
  }
}

// ─── Seams (104A economic graph, 104D missions) ──────────────────────────────

export interface TwinSeams {
  contributionMargin?: (svc: Svc, brokerageId: string, teamId: string | null) => Promise<{ cents: number | null; source: string }>
  missions?: (svc: Svc, brokerageId: string, teamId: string | null) => Promise<{ active: number; source: string }>
}

const SEAMS: TwinSeams = {}

/** Register a lazy seam. 104A registers `contributionMargin` (lib/kernel/economic-graph.ts);
 *  104D registers `missions`. Unregistered seams degrade to "unavailable" / "none". */
export function registerTwinSeam<K extends keyof TwinSeams>(key: K, fn: TwinSeams[K]): void {
  SEAMS[key] = fn
}

/** @proofSeam the proof reads the registry to assert degradation and presence. */
export function twinSeams(): Readonly<TwinSeams> {
  return SEAMS
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

const cents = (n: number | null | undefined) => Math.round((Number(n) || 0) * 100)
const countBy = <T,>(rows: T[], key: (r: T) => string | null | undefined): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const r of rows) { const k = key(r) ?? "unknown"; out[k] = (out[k] ?? 0) + 1 }
  return out
}
/** Latest row per key (rows ordered newest-first by the loader; the composer re-checks). */
function latestPer<T>(rows: T[], key: (r: T) => string, at: (r: T) => string): T[] {
  const seen = new Map<string, T>()
  for (const r of rows) {
    const k = key(r); const prev = seen.get(k)
    if (!prev || at(r) > at(prev)) seen.set(k, r)
  }
  return [...seen.values()]
}
const ids = (rows: Array<{ id?: string }>, n = 20) => rows.slice(0, n).map((r) => r.id).filter((x): x is string => !!x)

/** PURE: djb2 digest of a stable JSON — dedupe + change detection, never a security hash. */
export function twinDigest(measures: Record<string, number>): string {
  const s = JSON.stringify(Object.keys(measures).sort().map((k) => [k, measures[k]]))
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** PURE: the flat numeric measures a snapshot diff compares. */
export function twinMeasures(t: Pick<BrokerageTwin, "now" | "atRisk" | "capacity" | "objectives" | "economic"> & Partial<Pick<BrokerageTwin, "workforce">>): Record<string, number> {
  const m: Record<string, number> = {
    "now.pipeline.leads": t.now.pipeline.leads,
    "now.pipeline.converted90d": t.now.pipeline.converted90d,
    "now.contacts.active": t.now.contacts.active,
    "now.listings.active": t.now.listings.active,
    "now.transactions.open": t.now.transactions.open,
    "now.transactions.inEscrow": t.now.transactions.inEscrow,
    "now.transactions.openCommissionCents": t.now.transactions.openCommissionCents,
    "capacity.activeAgents": t.capacity.activeAgents,
    "capacity.headroom": t.capacity.headroom,
    "capacity.bands.over": t.capacity.bands.over,
    "capacity.bands.at_capacity": t.capacity.bands.at_capacity,
    "objectives.goals": t.objectives.goals.length,
    "objectives.strategyPending": t.objectives.strategyPending,
    "objectives.missions.active": t.objectives.missions.active,
    "economic.gciClosed90dCents": t.economic.gciClosed90dCents,
    "economic.closedCount90d": t.economic.closedCount90d,
    "economic.aiCost30dCents": t.economic.aiCost30dCents,
  }
  if (t.economic.projectedWeighted90Cents !== null) m["economic.projectedWeighted90Cents"] = t.economic.projectedWeighted90Cents
  for (const r of t.atRisk) m[`atRisk.${r.kind}.${r.severity}`] = r.count
  // 106E: a snapshot older than the workforce section carries none — the first build after it
  // reads every total as a change against 0 (a workforce that APPEARED is a change).
  if (t.workforce) {
    for (const k of WORKFORCE_CLASSIFICATIONS) m[`workforce.${k}`] = t.workforce.totals[k] ?? 0
    for (const d of t.workforce.territories) if (d.trend === "up") m[`workforce.territory.${d.territory}.sellerLeads30d`] = d.sellerLeads30d
  }
  return m
}

/** PURE: what changed between two measure sets. A measure present only on one side is a change
 *  against 0 (a risk that appeared or cleared IS a change). */
export function detectTwinChanges(previous: Record<string, number>, current: Record<string, number>): TwinChange[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)])
  const out: TwinChange[] = []
  for (const k of [...keys].sort()) {
    const p = previous[k] ?? 0, c = current[k] ?? 0
    if (p !== c) out.push({ field: k, previous: p, current: c, delta: c - p })
  }
  return out
}

// ─── Workforce classifier (PURE) ─────────────────────────────────────────────

const LUXURY_TAG = /luxury/i
const normList = (v: unknown): string[] => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []

/** PURE: classify ONE agent from its facts, its capacity line (the one answer) and the policy
 *  thresholds. Every verdict names its reader and threshold; a fact the reader could not produce
 *  (competency null) yields no classification — never a fabricated "in development".
 *  @proofSeam the proof asserts each classification against its threshold directly */
export function classifyWorkforceAgent(facts: WorkforceAgentFacts, capacity: TwinAgentCapacity | null, maxLoad: number, t: WorkforceThresholds): WorkforceClassified[] {
  const out: WorkforceClassified[] = []
  const add = (kind: WorkforceClassification, reader: string, value: number | string, threshold: number | string, reason: string) => out.push({ kind, evidence: { reader, value, threshold }, reason })
  if (facts.listings180d >= t.strong_listing_listings_180d) add("strong_listing", "listings.listing_date / listings.status=active (lib/kernel/brokerage-twin.ts loader)", facts.listings180d, t.strong_listing_listings_180d, `${facts.listings180d} listings taken in 180d (policy ≥ ${t.strong_listing_listings_180d})`)
  if (facts.offers180d >= t.strong_buyer_offers_180d) add("strong_buyer", "offers.agent_id (the offer rail)", facts.offers180d, t.strong_buyer_offers_180d, `${facts.offers180d} buyer offers written in 180d (policy ≥ ${t.strong_buyer_offers_180d})`)
  if (facts.investorContacts >= t.investor_contacts) add("investor", "contacts.contact_persona='investor' (m589 vocabulary)", facts.investorContacts, t.investor_contacts, `${facts.investorContacts} investor contacts on the book (policy ≥ ${t.investor_contacts})`)
  if (facts.languages.length >= t.bilingual_languages) add("bilingual", "agents.languages (app/actions/user-profile.ts)", facts.languages.join(", "), t.bilingual_languages, `speaks ${facts.languages.join(", ")} (policy ≥ ${t.bilingual_languages} languages)`)
  const luxuryTag = facts.specializations.some((s) => LUXURY_TAG.test(s))
  if (luxuryTag || facts.luxuryListings180d >= t.luxury_listings_180d) add("luxury_specialist", luxuryTag ? "agents.specializations (m492 list)" : `listings.list_price ≥ $${t.luxury_list_price_usd.toLocaleString()} in 180d`, luxuryTag ? "luxury" : facts.luxuryListings180d, luxuryTag ? "specialization tag" : t.luxury_listings_180d, luxuryTag ? "profile names a luxury specialization" : `${facts.luxuryListings180d} luxury listings taken in 180d (policy ≥ ${t.luxury_listings_180d})`)
  if (capacity) {
    const over = capacity.band === "over" || (t.overwhelmed_band === "at_capacity" && capacity.band === "at_capacity")
    if (over) add("overwhelmed", "capacityFor band + agent_retention_scores.tier (lib/lead-assignment/capacity-pick.ts)", capacity.band, t.overwhelmed_band, `capacity ${capacity.band}${capacity.fatigueTier ? `, fatigue ${capacity.fatigueTier}` : ""} (policy: ${t.overwhelmed_band} or beyond)${capacity.reasons.length ? ` — ${capacity.reasons[0]}` : ""}`)
    const loadPct = maxLoad > 0 ? Math.round((capacity.load / maxLoad) * 100) : 0
    if (capacity.band === "available" && loadPct <= t.underutilized_load_pct) add("underutilized", "capacityFor load vs tierMaxLoadForAgentCount", loadPct, t.underutilized_load_pct, `load ${capacity.load}/${maxLoad} (${loadPct}% of the ceiling, policy ≤ ${t.underutilized_load_pct}%)`)
  }
  if (facts.competencyGaps !== null && facts.competencyGaps >= t.in_development_gaps) add("in_development", "loadAgentCompetency gaps (lib/education/skill-freshness-radar.ts → scoreCompetency)", facts.competencyGaps, t.in_development_gaps, `${facts.competencyGaps} competency gap${facts.competencyGaps === 1 ? "" : "s"} open (policy ≥ ${t.in_development_gaps})`)
  return out
}

/** PURE: territory demand per farm territory — seller leads 30d vs the prior 30d, luxury share,
 *  and the serving agents' headroom / specialist coverage. Zips no farm covers fall into
 *  "unassigned" (demand with nobody serving it is the loudest recruiting signal). */
export function composeTerritoryDemand(
  f: TwinFacts["workforce"], at: string, perAgent: TwinAgentCapacity[], profiles: WorkforceAgentProfile[],
): TwinTerritoryDemand[] {
  const t = f.thresholds
  const atMs = new Date(at).getTime(), d30 = atMs - 30 * 86_400_000, d60 = atMs - 60 * 86_400_000
  const byName = new Map<string, { zips: Set<string>; agents: Set<string> }>()
  const zipToTerritory = new Map<string, string>()
  for (const farm of f.farms) {
    const name = (farm.name ?? "").trim() || "unnamed"
    const e = byName.get(name) ?? { zips: new Set<string>(), agents: new Set<string>() }
    for (const z of farm.zip_codes ?? []) { const zz = String(z).trim(); if (zz) { e.zips.add(zz); if (!zipToTerritory.has(zz)) zipToTerritory.set(zz, name) } }
    if (farm.agent_id) e.agents.add(farm.agent_id)
    byName.set(name, e)
  }
  const buckets = new Map<string, { cur: number; prev: number; lux: number }>()
  for (const name of byName.keys()) buckets.set(name, { cur: 0, prev: 0, lux: 0 })
  for (const l of f.sellerLeads60d) {
    const ms = new Date(l.created_at).getTime()
    if (!Number.isFinite(ms) || ms < d60 || ms > atMs) continue
    const name = (l.property_zip_code && zipToTerritory.get(String(l.property_zip_code).trim())) || "unassigned"
    const b = buckets.get(name) ?? { cur: 0, prev: 0, lux: 0 }
    if (ms >= d30) { b.cur++; if ((Number(l.estimated_value) || 0) >= t.luxury_list_price_usd) b.lux++ } else b.prev++
    buckets.set(name, b)
  }
  const capById = new Map(perAgent.map((a) => [a.agentId, a]))
  const profById = new Map(profiles.map((p) => [p.agentId, p]))
  const out: TwinTerritoryDemand[] = []
  for (const [name, b] of buckets) {
    const e = byName.get(name)
    const serving = e ? [...e.agents] : []
    const has = (id: string, k: WorkforceClassification) => profById.get(id)?.classifications.some((c) => c.kind === k) ?? false
    const trend: TwinTerritoryDemand["trend"] = b.cur >= t.demand_min_leads_30d && b.cur >= b.prev * (1 + t.demand_rise_pct / 100) && b.cur > b.prev ? "up" : b.cur < b.prev ? "down" : "flat"
    out.push({
      territory: name, zips: e ? [...e.zips].sort() : [], servingAgentIds: serving,
      sellerLeads30d: b.cur, sellerLeadsPrev30d: b.prev, trend,
      luxuryShare30d: b.cur > 0 ? b.lux / b.cur : 0,
      agentsWithHeadroom: serving.filter((id) => { const c = capById.get(id); return !!c && (c.band === "available" || c.band === "busy") }).length,
      listingSpecialists: serving.filter((id) => has(id, "strong_listing")).length,
      luxurySpecialists: serving.filter((id) => has(id, "luxury_specialist")).length,
    })
  }
  return out.sort((a, b) => b.sellerLeads30d - a.sellerLeads30d || a.territory.localeCompare(b.territory))
}

/** PURE: fold the workforce facts into the twin section (the composer calls it; the proof drives it). */
export function composeWorkforce(f: TwinFacts, scope: string): TwinWorkforce {
  const w = f.workforce
  const capById = new Map(f.capacity.perAgent.map((a) => [a.agentId, a]))
  const agents: WorkforceAgentProfile[] = w.agents.map((facts) => ({ agentId: facts.agentId, facts, classifications: classifyWorkforceAgent(facts, capById.get(facts.agentId) ?? null, f.capacity.maxLoad, w.thresholds) }))
  const totals = Object.fromEntries(WORKFORCE_CLASSIFICATIONS.map((k) => [k, 0])) as Record<WorkforceClassification, number>
  for (const a of agents) for (const c of a.classifications) totals[c.kind]++
  const territories = composeTerritoryDemand(w, f.at, f.capacity.perAgent, agents)
  const competencyRead = w.agents.filter((a) => a.competencyGaps !== null).length
  return {
    thresholds: w.thresholds, thresholdsSource: w.thresholdsSource, agents, totals, territories,
    evidence: [
      { table: "agents", filter: `${scope} ∧ is_active=true (languages, specializations)`, count: agents.length, via: "app/actions/user-profile.ts (profile writer) · classifyWorkforceAgent", ids: agents.slice(0, 20).map((a) => a.agentId) },
      { table: "listings", filter: `brokerage_id=${f.brokerageId} ∧ deleted_at IS NULL ∧ (listing_date ≥ at−180d ∨ status=active) per agent_id`, count: w.agents.reduce((a, x) => a + x.listings180d, 0), via: "listings.listing_date / list_price (lifecycle writers)" },
      { table: "offers", filter: `brokerage_id=${f.brokerageId} ∧ created_at ≥ at−180d per agent_id`, count: w.agents.reduce((a, x) => a + x.offers180d, 0), via: "offers.agent_id (the offer rail)" },
      { table: "contacts", filter: `brokerage_id=${f.brokerageId} ∧ deleted_at IS NULL ∧ contact_persona='investor' per agent_id`, count: w.agents.reduce((a, x) => a + x.investorContacts, 0), via: "contacts.contact_persona (normalizeContactPersona)" },
      { table: "(competency)", filter: `loadAgentCompetency per agent (${competencyRead} of ${agents.length} read)`, count: competencyRead, via: "lib/education/skill-freshness-radar.ts loadAgentCompetency → scoreCompetency gaps" },
      { table: "farm_territories", filter: `brokerage_id=${f.brokerageId} ∧ is_active=true`, count: w.farms.length, via: "farm_territories.name / zip_codes / agent_id (an agent's farm)" },
      { table: "leads", filter: `brokerage_id=${f.brokerageId} ∧ lead_type∈{seller,both} ∧ created_at ≥ at−60d (brokerage-owned, §5)`, count: w.sellerLeads60d.length, via: "leads.property_zip_code / estimated_value (lib/lead-pipeline)" },
      { table: "brokerage_settings", filter: `brokerage_id=${f.brokerageId} → settings.${WORKFORCE_THRESHOLDS_KEY} (${w.thresholdsSource})`, count: w.thresholdsSource === "policy" ? 1 : 0, via: "lib/kernel/tenant-policy.ts TENANT_POLICY_SETTINGS_KEYS.workforce_thresholds · resolveWorkforceThresholds" },
    ],
  }
}

/** PURE: the brokerage's recruiting NEEDS from the twin — territory demand ↑ vs the serving
 *  agents' capacity vs their specialist coverage → { territory, specialization, count, reasons }.
 *  No demand rise and enough covered headroom → no need (never a recruiting mission for its own
 *  sake). A rising territory nobody serves is a need of its whole demand. */
export function recruitingNeeds(twin: Pick<BrokerageTwin, "workforce">): RecruitingNeed[] {
  const t = twin.workforce.thresholds
  const out: RecruitingNeed[] = []
  for (const d of twin.workforce.territories) {
    if (d.trend !== "up") continue
    const required = Math.ceil(d.sellerLeads30d / t.seller_leads_per_agent_30d)
    const shortfall = required - d.agentsWithHeadroom
    const luxury = d.luxuryShare30d * 100 >= t.luxury_share_pct && d.luxurySpecialists === 0
    if (shortfall <= 0 && !luxury) continue
    const reasons = [
      `${d.territory}: seller leads ${d.sellerLeadsPrev30d} → ${d.sellerLeads30d} in 30d (policy: ≥ ${t.demand_rise_pct}% rise, ≥ ${t.demand_min_leads_30d} leads)`,
      `${required} listing agent${required === 1 ? "" : "s"} needed at ${t.seller_leads_per_agent_30d} seller leads each; ${d.agentsWithHeadroom} serving agent${d.agentsWithHeadroom === 1 ? "" : "s"} with headroom (${d.servingAgentIds.length} serving, ${d.listingSpecialists} strong listing)`,
    ]
    if (luxury) reasons.push(`${Math.round(d.luxuryShare30d * 100)}% of the seller leads are priced ≥ $${t.luxury_list_price_usd.toLocaleString()} and no serving agent is a luxury specialist (policy ≥ ${t.luxury_share_pct}%)`)
    out.push({ territory: d.territory, specialization: luxury ? "luxury" : "listing", count: Math.max(1, shortfall), reasons, zips: d.zips })
  }
  return out
}

/** PURE: the recruiting mission objective a need states (the owner's wording). */
export function recruitingNeedObjective(n: RecruitingNeed): string {
  return `find ${n.count} experienced listing agent${n.count === 1 ? "" : "s"} in ${n.territory} with ${n.specialization} specialization`
}

function riskSeverity(level: string | null): TwinRiskSeverity | null {
  if (level === "critical") return "critical"
  if (level === "at_risk" || level === "high") return "at_risk"
  if (level === "watch") return "watch"
  return null
}

// ─── Composer (PURE) ─────────────────────────────────────────────────────────

/** PURE: fold the facts into the twin. Every conclusion carries its evidence; nothing is
 *  predicted here — the predictors' outputs are read as they were written. */
export function composeBrokerageTwin(f: TwinFacts): BrokerageTwin {
  const b = f.brokerageId
  const scope = f.teamId ? `brokerage_id=${b} ∧ agent_id∈team(${f.teamId})` : `brokerage_id=${b}`
  const blindSpots = [...f.blindSpots]

  // NOW
  const openTx = f.transactions.filter((t) => (TRANSACTION_STATUSES_OPEN as readonly string[]).includes(t.status ?? ""))
  const escrowTx = openTx.filter((t) => (TRANSACTION_STATUSES_IN_ESCROW as readonly string[]).includes(t.status ?? ""))
  const activeListings = f.listings.filter((l) => l.status === "active")
  const now: TwinNow = {
    pipeline: {
      leads: f.leads.length,
      byLifecycle: countBy(f.leads, (l) => l.lifecycle_state),
      converted90d: f.converted90d,
      evidence: { table: "leads", filter: `${scope} ∧ is_active=true (converted90d: converted_at ≥ at−90d, head count)`, count: f.leads.length, via: "lib/lead-pipeline (lifecycle_state writer)", ids: ids(f.leads) },
    },
    contacts: { active: f.contactsActive, evidence: { table: "contacts", filter: `${scope} ∧ deleted_at IS NULL`, count: f.contactsActive, via: "head count" } },
    listings: {
      active: activeListings.length,
      byStatus: countBy(f.listings, (l) => l.status),
      evidence: { table: "listings", filter: `${scope} ∧ deleted_at IS NULL ∧ status∉{sold,cancelled,withdrawn,expired}`, count: f.listings.length, via: "listings.status (lifecycle writers)", ids: ids(activeListings) },
    },
    transactions: {
      open: openTx.length,
      inEscrow: escrowTx.length,
      openCommissionCents: openTx.reduce((a, t) => a + cents(t.estimated_commission), 0),
      evidence: { table: "transactions", filter: `${scope} ∧ deleted_at IS NULL ∧ status∈TRANSACTION_STATUSES_OPEN`, count: openTx.length, via: "lib/transactions/transaction-status.ts", ids: ids(openTx) },
    },
  }

  // AT RISK — read the predictors' outputs; one TwinRisk per (kind, severity) with rows behind it.
  const atRisk: TwinRisk[] = []
  const openTxIds = new Set(openTx.map((t) => t.id))
  const commissionByTx = new Map(openTx.map((t) => [t.id, cents(t.estimated_commission)]))
  const dh = latestPer(f.dealHealth, (r) => r.transaction_id, (r) => r.scored_at).filter((r) => openTxIds.has(r.transaction_id))
  for (const sev of ["critical", "at_risk", "watch"] as const) {
    const rows = dh.filter((r) => riskSeverity(r.risk_level) === sev)
    if (rows.length) atRisk.push({
      kind: "deal_health", severity: sev, count: rows.length,
      headline: `${rows.length} open deal${rows.length === 1 ? "" : "s"} scored ${sev} by deal health`,
      exposureCents: rows.reduce((a, r) => a + (commissionByTx.get(r.transaction_id) ?? 0), 0),
      evidence: { table: "deal_health_scores", filter: `brokerage_id=${b} ∧ latest per transaction ∧ risk_level=${sev} ∧ transaction open`, count: rows.length, via: "lib/deal-health/health-scorer.ts calculateDealHealth", ids: rows.slice(0, 20).map((r) => r.transaction_id) },
    })
  }
  const activeListingIds = new Set(activeListings.map((l) => l.id))
  const lh = latestPer(f.listingHealth, (r) => r.listing_id, (r) => r.scored_at).filter((r) => activeListingIds.has(r.listing_id))
  for (const sev of ["critical", "at_risk", "watch"] as const) {
    const rows = lh.filter((r) => riskSeverity(r.risk_level) === sev)
    if (rows.length) atRisk.push({
      kind: "listing_health", severity: sev, count: rows.length, exposureCents: null,
      headline: `${rows.length} active listing${rows.length === 1 ? "" : "s"} scored ${sev} by listing health`,
      evidence: { table: "listing_health_scores", filter: `brokerage_id=${b} ∧ latest per listing ∧ risk_level=${sev} ∧ listing active`, count: rows.length, via: "lib/listing-health/health-scorer.ts calculateListingHealth", ids: rows.slice(0, 20).map((r) => r.listing_id) },
    })
  }
  if (f.stallSignals.length) atRisk.push({
    kind: "stall", severity: "at_risk", count: f.stallSignals.length, exposureCents: null,
    headline: `${f.stallSignals.length} stall prediction${f.stallSignals.length === 1 ? "" : "s"} open on the manager bus`,
    evidence: { table: "manager_signals", filter: `brokerage_id=${b} ∧ signal_type∈{listing_stall_predicted,buyer_stall_predicted} ∧ consumed_at IS NULL ∧ created_at ≥ at−14d`, count: f.stallSignals.length, via: "lib/intelligence/listing-stall-predictor-runner.ts + buyer-stall-predictor-runner.ts", ids: ids(f.stallSignals) },
  })
  const fatigued = f.fatigue.filter((r) => r.risk_level === "high" || r.risk_level === "critical")
  if (fatigued.length) atRisk.push({
    kind: "fatigue", severity: fatigued.some((r) => r.risk_level === "critical") ? "critical" : "at_risk", count: fatigued.length, exposureCents: null,
    headline: `${fatigued.length} contact${fatigued.length === 1 ? "" : "s"} at high/critical fatigue`,
    evidence: { table: "buyer_fatigue_scores", filter: `brokerage_id=${b} ∧ risk_level∈{high,critical}`, count: fatigued.length, via: "lib/fatigue/fatigue-calculator.ts calculateFatigue", ids: fatigued.slice(0, 20).map((r) => r.contact_id) },
  })
  if (f.complianceOpen.length) atRisk.push({
    kind: "compliance", severity: f.complianceOpen.some((r) => r.severity === "critical" || r.severity === "high") ? "critical" : "at_risk",
    count: f.complianceOpen.length, exposureCents: null,
    headline: `${f.complianceOpen.length} compliance flag${f.complianceOpen.length === 1 ? "" : "s"} unresolved`,
    evidence: { table: "compliance_flags", filter: `brokerage_id=${b} ∧ status∈{flagged,reviewed}`, count: f.complianceOpen.length, via: "lib/compliance (flag writers)", ids: ids(f.complianceOpen) },
  })
  const retention = latestPer(f.retention, (r) => r.agent_id, (r) => r.score_date)
  const churn = retention.filter((r) => r.tier === "at_risk" || r.tier === "critical")
  if (churn.length) atRisk.push({
    kind: "retention", severity: churn.some((r) => r.tier === "critical") ? "critical" : "at_risk", count: churn.length, exposureCents: null,
    headline: `${churn.length} agent${churn.length === 1 ? "" : "s"} at flight risk`,
    evidence: { table: "agent_retention_scores", filter: `brokerage_id=${b} ∧ latest per agent ∧ tier∈{at_risk,critical}`, count: churn.length, via: "lib/recruiting/retention-radar.ts runRetentionRadar", ids: churn.slice(0, 20).map((r) => r.agent_id) },
  })

  // CAPACITY — capacityFor's answers, summed; never re-banded here.
  const bands = Object.fromEntries(CAPACITY_BANDS.map((k) => [k, 0])) as Record<CapacityBand, number>
  for (const a of f.capacity.perAgent) bands[a.band]++
  if (f.capacity.unscored > 0) blindSpots.push(`capacity: ${f.capacity.unscored} active agent(s) unscored (refused read) — not counted as available`)
  const capacity: TwinCapacity = {
    activeAgents: f.capacity.activeAgents, maxLoad: f.capacity.maxLoad, bands,
    headroom: f.capacity.perAgent.reduce((a, c) => a + c.headroom, 0),
    perAgent: f.capacity.perAgent, unscored: f.capacity.unscored,
    evidence: { table: "agents", filter: `${scope} ∧ is_active=true`, count: f.capacity.activeAgents, via: "lib/lead-assignment/capacity-pick.ts capacityFor (lib/kernel/capacity-guardian.ts computeCapacity)", ids: f.capacity.perAgent.slice(0, 20).map((a) => a.agentId) },
  }

  // OBJECTIVES
  const goals: TwinObjective[] = f.goals.map((g) => {
    const target = Number(g.target_value) || 0, current = Number(g.current_value) || 0
    return { id: g.id, agentId: g.agent_id, goalType: g.goal_type, targetValue: target, currentValue: current, progressPct: target > 0 ? Math.min(100, Math.round((current / target) * 100)) : null }
  })
  const objectives: TwinObjectives = {
    goals, strategyPending: f.strategyPending, missions: f.missions,
    evidence: [
      { table: "agent_goals", filter: `${scope} ∧ year=${new Date(f.at).getUTCFullYear()}`, count: goals.length, via: "app/actions/ai-agent-goals.ts (AGENT_GOAL_TYPES)", ids: ids(f.goals) },
      { table: "strategy_recommendations", filter: `brokerage_id=${b} ∧ status=pending`, count: f.strategyPending, via: "lib/kernel/strategy-session.ts" },
      { table: f.missions.status === "present" ? f.missions.source : "(no mission runtime registered — 104D seam)", filter: `brokerage_id=${b}`, count: f.missions.active, via: "registerTwinSeam('missions')" },
    ],
  }

  // ECONOMIC
  const forecast = f.forecast.filter((r) => r.weighted_90 !== null)
  const economic: TwinEconomic = {
    gciClosed90dCents: f.closed90d.reduce((a, t) => a + cents(t.commission_amount), 0),
    closedCount90d: f.closed90d.length,
    projectedWeighted90Cents: forecast.length ? forecast.reduce((a, r) => a + cents(r.weighted_90), 0) : null,
    aiCost30dCents: f.aiCost30dCents,
    contributionMargin: f.contributionMargin,
    evidence: [
      { table: "transactions", filter: `${scope} ∧ status∈{closed,funded} ∧ close_date ≥ at−90d`, count: f.closed90d.length, via: "transactions.commission_amount (lib/commission/*)", ids: ids(f.closed90d) },
      { table: "income_forecast_snapshots", filter: `brokerage_id=${b} ∧ latest per agent`, count: forecast.length, via: "lib/income-forecast/forecaster.ts computeIncomeForecastForAgent (weighted_90)" },
      { table: "ai_tool_usage", filter: `brokerage_id=${b} ∧ created_at ≥ at−30d`, count: -1, via: "ai_tool_usage.cost_cents (CLAUDE.md §5 cost ledger)" },
      { table: f.contributionMargin.status === "present" ? f.contributionMargin.source : "(no economic graph registered — 104A seam)", filter: `brokerage_id=${b}`, count: f.contributionMargin.cents === null ? 0 : 1, via: "registerTwinSeam('contributionMargin')" },
    ],
  }

  // WORKFORCE (106E) — classified from the facts above + the policy thresholds; composed AFTER
  // capacity so every "overwhelmed" / "underutilized" verdict reads the one capacity answer.
  const workforce = composeWorkforce(f, scope)

  const partial = { now, atRisk, capacity, objectives, economic, workforce }
  const measures = twinMeasures(partial)
  const changed: TwinChanged = f.previous
    ? { baseline: false, previousSnapshotId: f.previous.id, previousAt: f.previous.at, changes: detectTwinChanges(f.previous.measures, measures), reason: null }
    : { baseline: true, previousSnapshotId: null, previousAt: null, changes: [], reason: f.previousReason ?? "no prior snapshot" }

  return { brokerageId: b, teamId: f.teamId, at: f.at, ...partial, changed, blindSpots, digest: twinDigest(measures) }
}

// ─── Scenario foundation (PURE) ──────────────────────────────────────────────

/** Explicit input deltas. Anything else is UNSUPPORTED and comes back as such. */
export interface ScenarioDeltas {
  /** Agents added (+) or removed (−) from the active roster. Removed agents are the least loaded. */
  activeAgentsDelta?: number
  /** Per-agent working load scaled by this percentage (+20 = 20% more items per agent). */
  loadPerAgentPct?: number
  /** Projected pipeline value scaled by this percentage (applied to the forecaster's weighted_90). */
  pipelineValuePct?: number
  /** AI volume scaled by this percentage (applied to the ai_tool_usage meter). */
  aiVolumePct?: number
}

export const SCENARIO_DELTA_KEYS = ["activeAgentsDelta", "loadPerAgentPct", "pipelineValuePct", "aiVolumePct"] as const

export interface ScenarioOutput {
  field: string
  status: "ok" | "unsupported"
  value: number | Record<string, number> | null
  /** The twin fields and deltas this output was computed from. */
  inputs: string[]
  /** The existing predictor / meter whose output was recomputed or scaled — never a new model. */
  predictor: string
  reason?: string
}

export interface ScenarioResult {
  outputs: ScenarioOutput[]
  /** Delta keys the foundation does not understand (returned, never silently dropped). */
  unsupported: string[]
}

/** PURE: recompute DERIVED twin fields under explicit deltas. No new predictions — capacity goes
 *  back through computeCapacity, pipeline value scales the forecaster's own output, cost scales
 *  the meter. A question without an input returns "unsupported", never a number. */
export function scenario(twin: BrokerageTwin, deltas: ScenarioDeltas): ScenarioResult {
  const unsupported = Object.keys(deltas).filter((k) => !(SCENARIO_DELTA_KEYS as readonly string[]).includes(k))
  const outputs: ScenarioOutput[] = []

  // CAPACITY — the same math capacityFor uses, over the twin's per-agent signals.
  if (deltas.activeAgentsDelta !== undefined || deltas.loadPerAgentPct !== undefined) {
    const agentsDelta = Math.trunc(deltas.activeAgentsDelta ?? 0)
    const scale = 1 + (deltas.loadPerAgentPct ?? 0) / 100
    const inputs = ["capacity.perAgent", "capacity.activeAgents", ...(deltas.activeAgentsDelta !== undefined ? ["deltas.activeAgentsDelta"] : []), ...(deltas.loadPerAgentPct !== undefined ? ["deltas.loadPerAgentPct"] : [])]
    const predictor = "lib/kernel/capacity-guardian.ts computeCapacity / tierMaxLoadForAgentCount (the capacityFor math)"
    if (twin.capacity.perAgent.length === 0 || scale < 0) {
      outputs.push({ field: "capacity", status: "unsupported", value: null, inputs, predictor, reason: twin.capacity.perAgent.length === 0 ? "no scored agents in the twin" : "load scale below −100%" })
    } else {
      const roster = [...twin.capacity.perAgent].sort((a, b) => a.load - b.load)
      const headcount = Math.max(0, twin.capacity.activeAgents + agentsDelta)
      // Removed agents are the least loaded; their load is redistributed evenly across the rest.
      const removed = agentsDelta < 0 ? roster.splice(0, Math.min(-agentsDelta, roster.length)) : []
      const orphaned = removed.reduce((a, r) => a + r.load, 0)
      const added = agentsDelta > 0 ? agentsDelta : 0
      const kept = roster.length + added
      if (kept === 0 || headcount === 0) {
        outputs.push({ field: "capacity", status: "unsupported", value: null, inputs, predictor, reason: "scenario removes every agent" })
      } else {
        const maxLoad = tierMaxLoadForAgentCount(headcount)
        const perHead = orphaned / kept
        const bands = Object.fromEntries(CAPACITY_BANDS.map((k) => [k, 0])) as Record<CapacityBand, number>
        let headroom = 0
        const evaluate = (load: number, debt: number, fatigueTier: WorkloadSignals["fatigueTier"]) => {
          const c = computeCapacity({ activeContacts: Math.round(load), activeLeads: 0, activeDeals: 0, staleContacts: debt, overdueTasks: 0, fatigueTier }, { maxLoad })
          bands[c.band]++; headroom += c.headroom
        }
        for (const a of roster) evaluate((a.load + perHead) * scale, a.followUpDebt, a.fatigueTier)
        for (let i = 0; i < added; i++) evaluate(perHead * scale, 0, null)
        outputs.push({ field: "capacity", status: "ok", value: { activeAgents: headcount, maxLoad, headroom, ...bands }, inputs, predictor })
      }
    }
  }

  // PROJECTED PIPELINE VALUE — scales the forecaster's output; absent forecast → unsupported.
  if (deltas.pipelineValuePct !== undefined) {
    const inputs = ["economic.projectedWeighted90Cents", "deltas.pipelineValuePct"]
    const predictor = "lib/income-forecast/forecaster.ts computeIncomeForecastForAgent (income_forecast_snapshots.weighted_90)"
    if (twin.economic.projectedWeighted90Cents === null) {
      outputs.push({ field: "economic.projectedWeighted90Cents", status: "unsupported", value: null, inputs, predictor, reason: "no income forecast snapshot in the twin" })
    } else {
      outputs.push({ field: "economic.projectedWeighted90Cents", status: "ok", value: Math.round(twin.economic.projectedWeighted90Cents * (1 + deltas.pipelineValuePct / 100)), inputs, predictor })
    }
  }

  // AI COST — scales the meter (linear in volume; the platform covers AI with per-tier overage, §5).
  if (deltas.aiVolumePct !== undefined) {
    outputs.push({
      field: "economic.aiCost30dCents", status: "ok",
      value: Math.round(twin.economic.aiCost30dCents * (1 + deltas.aiVolumePct / 100)),
      inputs: ["economic.aiCost30dCents", "deltas.aiVolumePct"], predictor: "ai_tool_usage.cost_cents meter (lib/finance/usage-metering.ts rollup)",
    })
  }

  for (const k of unsupported) outputs.push({ field: k, status: "unsupported", value: null, inputs: [], predictor: "none", reason: `no derivation for "${k}" — the twin has no predictor output for it` })
  return { outputs, unsupported }
}

// ─── Objective decomposition (PURE) ──────────────────────────────────────────

export interface ObjectiveInput {
  goalType: AgentGoalType | string
  targetValue: number
  currentValue?: number
  /** Days left in the objective's horizon (a year goal mid-year passes the remaining days). */
  horizonDays?: number
}

export interface SubTarget {
  key: string
  label: string
  /** The twin field that measures it (dotted path), or null when the twin has no measure. */
  measuredBy: string | null
  /** Target for the sub-target, null when it cannot be derived from the twin. */
  target: number | null
  /** The twin's current reading for the field (null when unsupported or absent). */
  current: number | null
  status: "ok" | "unsupported"
  reason?: string
}

export interface DecomposedObjective {
  goalType: string
  status: "ok" | "unsupported"
  remaining: number
  subTargets: SubTarget[]
  reason?: string
}

/** The twin field each goal type is MEASURED by. Null = the twin carries no measure (honest). */
export const OBJECTIVE_MEASURES: Record<AgentGoalType, string | null> = {
  gross_commission:    "economic.gciClosed90dCents",
  transactions_closed: "economic.closedCount90d",
  listings_taken:      "now.listings.active",
  buyer_clients:       "now.pipeline.byLifecycle.representation",
  new_contacts:        "now.contacts.active",
  conversion_rate:     "now.pipeline.converted90d",
  avg_days_to_close:   null,
  referrals_generated: null,
  reviews_requested:   null,
}

/** PURE: read one numeric twin measure by its dotted path (the field a sub-target / a mission
 *  criterion names — OBJECTIVE_MEASURES vocabulary). null when absent or not a number, never 0. */
export function readTwinMeasure(twin: BrokerageTwin, path: string): number | null {
  let cur: any = twin
  for (const p of path.split(".")) { if (cur == null || typeof cur !== "object") return null; cur = cur[p] }
  return typeof cur === "number" ? cur : null
}
const readPath = readTwinMeasure

/** PURE: decompose a brokerage objective (agent_goals vocabulary) into measurable sub-targets,
 *  each naming the twin field that measures it. Unknown goal types and measures the twin lacks
 *  come back "unsupported" — never an invented number. Feeds 104D missions. */
export function decomposeObjective(objective: ObjectiveInput, twin?: BrokerageTwin | null): DecomposedObjective {
  if (!isAgentGoalType(objective.goalType)) {
    return { goalType: objective.goalType, status: "unsupported", remaining: 0, subTargets: [], reason: `goal_type not in AGENT_GOAL_TYPES (${AGENT_GOAL_TYPES.join(", ")})` }
  }
  const remaining = Math.max(0, (Number(objective.targetValue) || 0) - (Number(objective.currentValue) || 0))
  const measure = OBJECTIVE_MEASURES[objective.goalType]
  const sub: SubTarget[] = []
  const reading = (path: string | null) => (twin && path ? readPath(twin, path) : null)

  if (measure === null) {
    sub.push({ key: objective.goalType, label: "progress", measuredBy: null, target: remaining, current: null, status: "unsupported", reason: "the twin carries no measure for this goal type (hand-updated goal)" })
    return { goalType: objective.goalType, status: "unsupported", remaining, subTargets: sub, reason: "no twin measure" }
  }

  sub.push({ key: "headline", label: "the objective itself", measuredBy: measure, target: remaining, current: reading(measure), status: "ok" })

  if (objective.goalType === "gross_commission") {
    // closings needed = remaining ÷ the brokerage's own average closed GCI (twin ratio, no model).
    const gci = reading("economic.gciClosed90dCents"), n = reading("economic.closedCount90d")
    const avg = gci !== null && n !== null && n > 0 ? gci / n : null
    sub.push(avg
      ? { key: "closings_needed", label: "closings needed at the trailing average GCI per close", measuredBy: "economic.closedCount90d", target: Math.ceil(remaining / avg), current: n, status: "ok" }
      : { key: "closings_needed", label: "closings needed", measuredBy: "economic.closedCount90d", target: null, current: n, status: "unsupported", reason: "no closed deals in the trailing 90 days to average" })
    sub.push({ key: "under_contract_coverage", label: "deals in escrow covering the closings needed", measuredBy: "now.transactions.inEscrow", target: avg ? Math.ceil(remaining / avg) : null, current: reading("now.transactions.inEscrow"), status: avg ? "ok" : "unsupported", reason: avg ? undefined : "depends on closings_needed" })
    sub.push({ key: "open_commission", label: "open pipeline commission vs remaining", measuredBy: "now.transactions.openCommissionCents", target: remaining, current: reading("now.transactions.openCommissionCents"), status: "ok" })
  } else if (objective.goalType === "transactions_closed") {
    sub.push({ key: "under_contract_coverage", label: "deals in escrow covering the remaining closes", measuredBy: "now.transactions.inEscrow", target: remaining, current: reading("now.transactions.inEscrow"), status: "ok" })
    sub.push({ key: "open_deals", label: "open deals feeding escrow", measuredBy: "now.transactions.open", target: remaining, current: reading("now.transactions.open"), status: "ok" })
  } else if (objective.goalType === "listings_taken") {
    sub.push({ key: "active_listings", label: "active listings on the board", measuredBy: "now.listings.active", target: remaining, current: reading("now.listings.active"), status: "ok" })
  } else if (objective.goalType === "buyer_clients") {
    sub.push({ key: "representation", label: "leads at representation", measuredBy: "now.pipeline.byLifecycle.representation", target: remaining, current: reading("now.pipeline.byLifecycle.representation"), status: "ok" })
    sub.push({ key: "qualifying", label: "leads in ISA qualification feeding representation", measuredBy: "now.pipeline.byLifecycle.isa_qualifying", target: null, current: reading("now.pipeline.byLifecycle.isa_qualifying"), status: "unsupported", reason: "no qualification→representation rate in the twin" })
  } else if (objective.goalType === "conversion_rate") {
    const leads = reading("now.pipeline.leads"), conv = reading("now.pipeline.converted90d")
    sub.push({ key: "conversions_needed", label: "conversions needed on the current lead base", measuredBy: "now.pipeline.converted90d", target: leads !== null ? Math.ceil((Number(objective.targetValue) / 100) * leads) : null, current: conv, status: leads !== null ? "ok" : "unsupported", reason: leads !== null ? undefined : "no lead base in the twin" })
  } else if (objective.goalType === "new_contacts") {
    sub.push({ key: "contacts", label: "active contacts", measuredBy: "now.contacts.active", target: remaining, current: reading("now.contacts.active"), status: "ok" })
  }
  return { goalType: objective.goalType, status: "ok", remaining, subTargets: sub }
}

// ─── Loader (reads the real ledgers; every read tenant-pinned; refusals read) ─

export interface LoadTwinOptions {
  at?: Date
  /** Team scope: only this team's agents' leads / listings / deals / goals (teams see their board). */
  teamId?: string | null
  /** Cap on agents scored per build (each is capacityFor — several head counts). Published as a blind spot when hit. */
  maxAgentsScored?: number
  /** Injected capacity reader (proofs). Defaults to capacityFor. */
  capacityFor?: (svc: Svc, brokerageId: string, agentId: string, opts: { now: Date; maxLoad: number }) => Promise<{ band: CapacityBand; load: number; headroom: number; reasons: string[]; index: { followUpDebt: number } }>
  /** 106E — injected competency reader (proofs). Defaults to loadAgentCompetency (the one reader). */
  competencyFor?: (svc: Svc, agent: { id: string; user_id: string | null; brokerage_id: string }, now: Date) => Promise<{ gaps: ReadonlyArray<unknown>; refusedRails: string[] }>
  seams?: TwinSeams
}

const CLOSED_STATUSES = ["closed", "funded"]
const RETIRED_LISTING_STATUSES = ["sold", "cancelled", "withdrawn", "expired"]
export const TWIN_SNAPSHOT_TABLE = "brokerage_twin_snapshots"

/** Read the facts the composer folds. Every read is pinned to brokerageId; team scope narrows
 *  through agents.team_id. A refused read is NAMED in blindSpots and counts as nothing. */
export async function loadBrokerageTwinFacts(svc: Svc, brokerageId: string, opts: LoadTwinOptions = {}): Promise<TwinFacts> {
  const at = opts.at ?? new Date()
  const atIso = at.toISOString()
  const teamId = opts.teamId ?? null
  const blindSpots: string[] = []
  const since = (days: number) => new Date(at.getTime() - days * 86_400_000).toISOString()
  const refused = (what: string, e: { message?: string } | null | undefined) => { if (e) blindSpots.push(`${what}: refused — ${e.message ?? "unknown"}`) }
  const rows = async <T,>(what: string, q: any): Promise<T[]> => { const { data, error } = await q; refused(what, error); return (error ? [] : (data ?? [])) as T[] }
  const head = async (what: string, q: any): Promise<number> => { const { count, error } = await q; refused(what, error); return error ? 0 : (count ?? 0) }

  // Roster (and the team's agent ids when scoped).
  // 106E: the profile columns (languages, specializations) ride the same roster read.
  let agentQ = svc.from("agents").select("id, is_active, team_id, user_id, languages, specializations").eq("brokerage_id", brokerageId).eq("is_active", true).limit(2000)
  if (teamId) agentQ = agentQ.eq("team_id", teamId)
  const agents = await rows<{ id: string; user_id?: string | null; languages?: unknown; specializations?: unknown }>("agents", agentQ)
  const agentIds = agents.map((a) => a.id)
  const scoped = (q: any) => (teamId ? q.in("agent_id", agentIds.length ? agentIds : ["00000000-0000-0000-0000-000000000000"]) : q)
  const LIMIT = 5000

  const [leads, converted90d, contactsActive, listings, transactions, closed90d, dealHealth, listingHealth, stallSignals, fatigue, retention, complianceOpen, goals, strategyPending, forecast, aiRows] = await Promise.all([
    rows<TwinFacts["leads"][number]>("leads", scoped(svc.from("leads").select("id, lifecycle_state, agent_id").eq("brokerage_id", brokerageId).eq("is_active", true)).limit(LIMIT)),
    head("leads(converted 90d)", scoped(svc.from("leads").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).gte("converted_at", since(90)))),
    head("contacts", scoped(svc.from("contacts").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).is("deleted_at", null))),
    rows<TwinFacts["listings"][number]>("listings", scoped(svc.from("listings").select("id, status, agent_id").eq("brokerage_id", brokerageId).is("deleted_at", null).not("status", "in", `(${RETIRED_LISTING_STATUSES.map((s) => `"${s}"`).join(",")})`)).limit(LIMIT)),
    rows<TwinFacts["transactions"][number]>("transactions", scoped(svc.from("transactions").select("id, status, estimated_commission, agent_id").eq("brokerage_id", brokerageId).is("deleted_at", null).in("status", [...TRANSACTION_STATUSES_OPEN])).limit(LIMIT)),
    rows<TwinFacts["closed90d"][number]>("transactions(closed 90d)", scoped(svc.from("transactions").select("id, commission_amount, agent_id").eq("brokerage_id", brokerageId).is("deleted_at", null).in("status", CLOSED_STATUSES).gte("close_date", since(90).slice(0, 10))).limit(LIMIT)),
    rows<TwinFacts["dealHealth"][number]>("deal_health_scores", svc.from("deal_health_scores").select("transaction_id, risk_level, scored_at").eq("brokerage_id", brokerageId).order("scored_at", { ascending: false }).limit(LIMIT)),
    rows<TwinFacts["listingHealth"][number]>("listing_health_scores", svc.from("listing_health_scores").select("listing_id, risk_level, scored_at").eq("brokerage_id", brokerageId).order("scored_at", { ascending: false }).limit(LIMIT)),
    rows<TwinFacts["stallSignals"][number]>("manager_signals(stall)", svc.from("manager_signals").select("id, signal_type, entity_id").eq("brokerage_id", brokerageId).in("signal_type", ["listing_stall_predicted", "buyer_stall_predicted"]).is("consumed_at", null).gte("created_at", since(14)).limit(LIMIT)),
    rows<TwinFacts["fatigue"][number]>("buyer_fatigue_scores", svc.from("buyer_fatigue_scores").select("contact_id, risk_level").eq("brokerage_id", brokerageId).in("risk_level", ["high", "critical"]).limit(LIMIT)),
    rows<TwinFacts["retention"][number]>("agent_retention_scores", svc.from("agent_retention_scores").select("agent_id, tier, score_date").eq("brokerage_id", brokerageId).gte("score_date", since(30).slice(0, 10)).order("score_date", { ascending: false }).limit(LIMIT)),
    rows<TwinFacts["complianceOpen"][number]>("compliance_flags", svc.from("compliance_flags").select("id, severity").eq("brokerage_id", brokerageId).in("status", ["flagged", "reviewed"]).limit(LIMIT)),
    rows<TwinFacts["goals"][number]>("agent_goals", scoped(svc.from("agent_goals").select("id, agent_id, goal_type, target_value, current_value").eq("brokerage_id", brokerageId).eq("year", at.getUTCFullYear())).limit(LIMIT)),
    head("strategy_recommendations", svc.from("strategy_recommendations").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("status", "pending")),
    rows<{ agent_id: string; weighted_90: number | null; computed_at: string }>("income_forecast_snapshots", svc.from("income_forecast_snapshots").select("agent_id, weighted_90, computed_at").eq("brokerage_id", brokerageId).order("computed_at", { ascending: false }).limit(LIMIT)),
    rows<{ cost_cents: number | null }>("ai_tool_usage", svc.from("ai_tool_usage").select("cost_cents").eq("brokerage_id", brokerageId).gte("created_at", since(30)).limit(LIMIT)),
  ])
  for (const [what, n] of [["leads", leads.length], ["listings", listings.length], ["transactions", transactions.length], ["ai_tool_usage", aiRows.length]] as const) {
    if (n >= LIMIT) blindSpots.push(`${what}: row cap ${LIMIT} reached — counts are a floor`)
  }

  // Retention: latest tier per agent (also feeds capacity's fatigue tier).
  const tierByAgent = new Map<string, string | null>()
  for (const r of retention) if (!tierByAgent.has(r.agent_id)) tierByAgent.set(r.agent_id, r.tier)

  // Capacity — capacityFor per active agent (bounded), the ceiling resolved ONCE.
  const maxScored = opts.maxAgentsScored ?? 60
  const maxLoad = tierMaxLoadForAgentCount(agents.length || 1)
  // capacityFor is typed on the real service client; the twin's Svc is the structural subset every
  // proof client satisfies — the cast crosses only that nominal gap, never a tenant boundary.
  const capacityReader: NonNullable<LoadTwinOptions["capacityFor"]> = opts.capacityFor
    ?? (async (s, b, id, o) => (await import("@/lib/lead-assignment/capacity-pick")).capacityFor(s as any, b, id, o))
  const perAgent: TwinAgentCapacity[] = []
  let unscored = 0
  for (const a of agents.slice(0, maxScored)) {
    try {
      const c = await capacityReader(svc, brokerageId, a.id, { now: at, maxLoad })
      perAgent.push({ agentId: a.id, band: c.band, load: c.load, headroom: c.headroom, followUpDebt: c.index.followUpDebt, fatigueTier: (tierByAgent.get(a.id) ?? null) as WorkloadSignals["fatigueTier"], reasons: c.reasons })
    } catch (e) { unscored++; blindSpots.push(`capacityFor(${a.id}) threw: ${e instanceof Error ? e.message : String(e)}`) }
  }
  if (agents.length > maxScored) { unscored += agents.length - maxScored; blindSpots.push(`capacity: ${agents.length - maxScored} agent(s) beyond the ${maxScored}-agent scoring cap`) }

  // WORKFORCE (106E) — the per-agent facts behind the classifications, every read tenant-pinned.
  const [settingsRow, listings180, offers180, investorContacts, farms, sellerLeads60d] = await Promise.all([
    (async () => { const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle(); refused("brokerage_settings(workforce_thresholds)", error); return error ? null : (data as { settings?: unknown } | null) })(),
    rows<{ id: string; agent_id: string | null; list_price: number | null }>("listings(180d)", scoped(svc.from("listings").select("id, agent_id, list_price, listing_date").eq("brokerage_id", brokerageId).is("deleted_at", null).gte("listing_date", since(180).slice(0, 10))).limit(LIMIT)),
    rows<{ id: string; agent_id: string | null }>("offers(180d)", scoped(svc.from("offers").select("id, agent_id").eq("brokerage_id", brokerageId).gte("created_at", since(180))).limit(LIMIT)),
    rows<{ id: string; agent_id: string | null }>("contacts(investor)", scoped(svc.from("contacts").select("id, agent_id").eq("brokerage_id", brokerageId).is("deleted_at", null).eq("contact_persona", "investor")).limit(LIMIT)),
    rows<TwinFacts["workforce"]["farms"][number]>("farm_territories", svc.from("farm_territories").select("name, zip_codes, agent_id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(LIMIT)),
    rows<TwinFacts["workforce"]["sellerLeads60d"][number]>("leads(seller 60d)", svc.from("leads").select("id, property_zip_code, estimated_value, created_at").eq("brokerage_id", brokerageId).in("lead_type", ["seller", "both"]).gte("created_at", since(60)).limit(LIMIT)),
  ])
  const settingsHasKey = !!(settingsRow?.settings && typeof settingsRow.settings === "object" && (settingsRow.settings as Record<string, unknown>)[WORKFORCE_THRESHOLDS_KEY])
  const thresholds = resolveWorkforceThresholds(settingsRow?.settings)
  const activeListingIds = new Set(listings.filter((l) => l.status === "active").map((l) => l.id))
  const perAgentCount = (list: Array<{ agent_id: string | null }>) => { const m = new Map<string, number>(); for (const r of list) if (r.agent_id) m.set(r.agent_id, (m.get(r.agent_id) ?? 0) + 1); return m }
  // Listings taken = listing_date in 180d ∪ active now (deduped by id).
  const takenById = new Map<string, { agent_id: string | null; list_price: number | null }>()
  for (const l of listings180) takenById.set(l.id, l)
  for (const l of listings as Array<{ id: string; status: string | null; agent_id?: string | null }>) if (activeListingIds.has(l.id) && !takenById.has(l.id)) takenById.set(l.id, { agent_id: l.agent_id ?? null, list_price: null })
  const taken = [...takenById.values()]
  const listingsBy = perAgentCount(taken), luxuryBy = perAgentCount(taken.filter((l) => (Number(l.list_price) || 0) >= thresholds.luxury_list_price_usd))
  const offersBy = perAgentCount(offers180), investorBy = perAgentCount(investorContacts)
  const competencyReader: NonNullable<LoadTwinOptions["competencyFor"]> = opts.competencyFor
    ?? (async (s, a, n) => (await import("@/lib/education/skill-freshness-radar")).loadAgentCompetency(s as any, a, n))
  const workforceAgents: WorkforceAgentFacts[] = []
  for (const a of agents.slice(0, maxScored)) {
    const facts: WorkforceAgentFacts = {
      agentId: a.id, userId: a.user_id ?? null, languages: normList(a.languages), specializations: normList(a.specializations),
      listings180d: listingsBy.get(a.id) ?? 0, luxuryListings180d: luxuryBy.get(a.id) ?? 0, offers180d: offersBy.get(a.id) ?? 0,
      investorContacts: investorBy.get(a.id) ?? 0, competencyGaps: null, competencyRefused: null,
    }
    try {
      const c = await competencyReader(svc, { id: a.id, user_id: a.user_id ?? null, brokerage_id: brokerageId }, at)
      facts.competencyGaps = c.gaps.length
      if (c.refusedRails.length) facts.competencyRefused = c.refusedRails.join("; ")
    } catch (e) { facts.competencyRefused = e instanceof Error ? e.message : String(e); blindSpots.push(`competency(${a.id}) threw: ${facts.competencyRefused}`) }
    workforceAgents.push(facts)
  }

  // Seams — degrade cleanly.
  const seams = { ...SEAMS, ...(opts.seams ?? {}) }
  let contributionMargin: TwinEconomic["contributionMargin"] = { status: "unavailable", cents: null, source: "lib/kernel/economic-graph.ts not registered (104A)" }
  if (seams.contributionMargin) {
    try { const r = await seams.contributionMargin(svc, brokerageId, teamId); contributionMargin = { status: "present", cents: r.cents, source: r.source } }
    catch (e) { blindSpots.push(`contributionMargin seam threw: ${e instanceof Error ? e.message : String(e)}`) }
  }
  let missions: TwinObjectives["missions"] = { status: "none", active: 0, source: "mission runtime not registered (104D)" }
  if (seams.missions) {
    try { const r = await seams.missions(svc, brokerageId, teamId); missions = { status: "present", active: r.active, source: r.source } }
    catch (e) { blindSpots.push(`missions seam threw: ${e instanceof Error ? e.message : String(e)}`) }
  }

  // Previous snapshot — the error is READ (an unapplied m708 is a named blind spot, not a baseline lie).
  let previous: TwinFacts["previous"] = null
  let previousReason: string | null = null
  {
    let q = svc.from(TWIN_SNAPSHOT_TABLE).select("id, at, twin").eq("brokerage_id", brokerageId).lt("at", atIso).order("at", { ascending: false }).limit(1)
    q = teamId ? q.eq("team_id", teamId) : q.is("team_id", null)
    const { data, error } = await q
    if (error) { previousReason = `snapshot read refused: ${error.message}`; blindSpots.push(`${TWIN_SNAPSHOT_TABLE}: ${previousReason}`) }
    else {
      const row = (data ?? [])[0] as { id: string; at: string; twin: any } | undefined
      if (row?.twin) previous = { id: row.id, at: row.at, measures: twinMeasures(row.twin as BrokerageTwin) }
      else previousReason = "no prior snapshot"
    }
  }

  return {
    brokerageId, teamId, at: atIso,
    leads, converted90d, contactsActive, listings, transactions, closed90d, dealHealth, listingHealth, stallSignals, fatigue, retention, complianceOpen,
    goals, strategyPending,
    capacity: { maxLoad, perAgent, unscored, activeAgents: agents.length },
    forecast: latestPer(forecast, (r) => r.agent_id, (r) => r.computed_at),
    aiCost30dCents: aiRows.reduce((a, r) => a + (Number(r.cost_cents) || 0), 0),
    contributionMargin, missions, previous, previousReason, blindSpots,
    workforce: { thresholds, thresholdsSource: settingsHasKey ? "policy" : "default", agents: workforceAgents, farms, sellerLeads60d },
  }
}

export interface BuildTwinResult {
  twin: BrokerageTwin
  persist: { attempted: boolean; snapshotId: string | null; error: string | null }
}

/** THE ONE READ. Build the twin for a brokerage at an instant, and persist the snapshot (the
 *  evidence of what the OS believed at `at`; the next build diffs against it). `persist: false`
 *  for a read-only view. The caller resolves brokerageId from the SESSION. */
export async function buildBrokerageTwin(
  brokerageId: string, at: Date = new Date(),
  opts: LoadTwinOptions & { svc?: Svc; persist?: boolean } = {},
): Promise<BuildTwinResult> {
  if (!brokerageId) throw new Error("brokerage-twin: brokerageId is required (resolve it from the session)")
  const svc: Svc = opts.svc ?? (await import("@/lib/supabase/service")).createServiceClient()
  const facts = await loadBrokerageTwinFacts(svc, brokerageId, { ...opts, at })
  const twin = composeBrokerageTwin(facts)
  const persist: BuildTwinResult["persist"] = { attempted: opts.persist !== false, snapshotId: null, error: null }
  if (persist.attempted) {
    const { data, error } = await svc.from(TWIN_SNAPSHOT_TABLE).insert({
      brokerage_id: brokerageId, team_id: twin.teamId, at: twin.at,
      twin, digest: twin.digest, previous_snapshot_id: twin.changed.previousSnapshotId,
    }).select("id").maybeSingle()
    if (error) persist.error = error.message
    else persist.snapshotId = (data as { id?: string } | null)?.id ?? null
  }
  return { twin, persist }
}

/** A persisted twin older than this is NOT handed to a per-agent surface — it falls back to the live
 *  answer (capacityFor) rather than ranking a day on yesterday's board. */
export const TWIN_SNAPSHOT_MAX_AGE_HOURS = 24

/**
 * Read-only helper for surfaces: the twin, or null when it cannot be had (never a fake twin).
 *   · default — a fresh build (persist: false);
 *   · `snapshot` — THE LAST PERSISTED TWIN (brokerage_twin_snapshots, the Command Center's build),
 *     for the tenant (and team when given), no older than maxAgeHours. The per-agent surfaces
 *     (morning stand-up, team-lead brief) read this: one build per Command Center visit serves
 *     every agent's line instead of a capacityFor per stand-up. Absent / stale / refused → null.
 */
export async function readBrokerageTwin(
  brokerageId: string,
  opts: LoadTwinOptions & { svc?: Svc; snapshot?: { maxAgeHours?: number; now?: Date } } = {},
): Promise<BrokerageTwin | null> {
  if (!brokerageId) return null
  if (opts.snapshot) {
    try {
      const svc: Svc = opts.svc ?? (await import("@/lib/supabase/service")).createServiceClient()
      const now = opts.snapshot.now ?? new Date()
      const maxAge = opts.snapshot.maxAgeHours ?? TWIN_SNAPSHOT_MAX_AGE_HOURS
      let q = svc.from(TWIN_SNAPSHOT_TABLE).select("id, at, twin").eq("brokerage_id", brokerageId)
        .gte("at", new Date(now.getTime() - maxAge * 3_600_000).toISOString())
        .order("at", { ascending: false }).limit(1)
      q = opts.teamId ? q.eq("team_id", opts.teamId) : q.is("team_id", null)
      const { data, error } = await q
      if (error) { console.error(`[brokerage-twin] snapshot read refused for ${brokerageId}: ${error.message}`); return null }
      const row = ((data ?? []) as Array<{ id: string; at: string; twin: BrokerageTwin | null }>)[0]
      // The row is trusted only when it is THIS tenant's twin (a foreign row never reaches the caller).
      return row?.twin && row.twin.brokerageId === brokerageId ? row.twin : null
    } catch (e) { console.error(`[brokerage-twin] snapshot read failed for ${brokerageId}: ${e instanceof Error ? e.message : String(e)}`); return null }
  }
  try { return (await buildBrokerageTwin(brokerageId, opts.at, { ...opts, persist: false })).twin }
  catch (e) { console.error(`[brokerage-twin] build failed for ${brokerageId}: ${e instanceof Error ? e.message : String(e)}`); return null }
}

/** PURE: the agent's capacity line from the twin (the morning stand-up's one read). */
export function twinCapacityForAgent(twin: BrokerageTwin | null | undefined, agentId: string): TwinAgentCapacity | null {
  return twin?.capacity.perAgent.find((a) => a.agentId === agentId) ?? null
}

/**
 * 106E — THE WORKFORCE PROFILE of a brokerage (or a team's board under teamId): the classified
 * roster, the totals ("18 strong listing agents … 5 underutilized") and the territory demand,
 * read from the last persisted twin (snapshot mode — the Command Center's build) or built fresh.
 * null when no twin can be had (never a fake roster). The caller resolves brokerageId from the
 * SESSION; a snapshot older than the workforce section (no `workforce`) is rebuilt.
 */
// TOMBSTONE (wave 106 integration, CLAUDE.md §1.1): `workforceProfile(brokerageId, opts)` was a second
// spelling of `readBrokerageTwin(brokerageId, opts)?.workforce` (the survivor) and nothing but its proof
// called it. Readers take the section from the twin they already hold (recruiting-roi.ts, command-center.ts).
/** PURE: the owner's one-line reading of the totals ("18 strong listing · 5 underutilized …"). */
export function workforceLine(w: Pick<TwinWorkforce, "totals" | "agents"> | null | undefined): string | null {
  if (!w) return null
  const label: Record<WorkforceClassification, string> = { strong_listing: "strong listing", strong_buyer: "strong buyer", investor: "investor", bilingual: "bilingual", luxury_specialist: "luxury", overwhelmed: "overwhelmed", underutilized: "underutilized", in_development: "in development" }
  const parts = WORKFORCE_CLASSIFICATIONS.filter((k) => w.totals[k] > 0).map((k) => `${w.totals[k]} ${label[k]}`)
  return `${w.agents.length} agent${w.agents.length === 1 ? "" : "s"} profiled${parts.length ? ` — ${parts.join(" · ")}` : ""}`
}

// TOMBSTONE (wave 104 integration, CLAUDE.md §1.3): `hasHeadroom` was re-exported here as a hidden
// wire; its survivor is lib/kernel/capacity-guardian.ts:hasHeadroom and every caller imports it there.
