// lib/kernel/twin-scenario.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SCENARIO / WHAT-IF ENGINE ON THE TWIN (wave 107, lane 107D). Owner: "What happens if we
// increase seller lead acquisition 30%?" — "Not another manager." — "No production action yet.
// Simulation first."
//
// SURVIVOR EXTENDED, NOT REPLACED: lib/kernel/brokerage-twin.ts `scenario(twin, deltas)` (104B) is the
// scenario foundation — capacity recomputed through computeCapacity (the capacityFor math), pipeline
// value / AI cost by scaling the forecaster / meter. simulateScenario CALLS it for the agent-capacity
// stage (never a second capacity model) and adds what it lacked: NAMED LEVERS propagated through the
// twin's system flows, a saturation search, cost / margin, risks, and a coefficient list in which
// every number names its SOURCE and CONFIDENCE (a missing input is an ASSUMPTION, never a silent 0).
// It lives beside the twin rather than inside it so the twin's composer (107C) and the scenario
// functions (107D) do not share a file; the twin remains the only read model.
//
// PROPAGATION CHAIN (SCENARIO_PROPAGATION_CHAIN — the order the lever flows):
//   seller demand → buyer demand → AI ISA capacity (throughput) → agent capacity (scenario() →
//   computeCapacity bands) → competency coverage (workforce specialists) → territories (farm demand
//   vs serving headroom) → campaign + ads (marginal cost per lead, territory_metrics) → media (106C
//   lineage per new listing) → transaction capacity (deal desk load) → expected revenue (the twin's
//   own stage conversion + GCI per close) → fatigue (contact fatigue share + agent bands).
//
// DOMAIN COEFFICIENTS come from SCENARIO_CONTRIBUTORS — ONE PURE CONTRIBUTOR PER MANAGER DOMAIN, keyed
// by the MANAGERS registry (lib/kernel/manager-registry.ts). A contributor is a function of (twin,
// facts) → coefficients (+ risks); it is not a manager and holds no authority.
//
// NO WRITER: this module reads (loadScenarioFacts) and computes. It imports no service client, no
// ledger, no mission writer, and names no write verb — the census in scripts/scenario-engine-guard.ts
// asserts it. Persisting a run as evidence (agent_action_ledger, `twin.scenario.simulate`) and
// promoting it to a PROPOSED mission happen in the session-gated caller (app/actions/twin-scenario.ts).

import { scenario, twinDigest, type BrokerageTwin, type ScenarioOutput } from "@/lib/kernel/brokerage-twin"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = { from: (table: string) => any }

// ─── Levers ──────────────────────────────────────────────────────────────────

export const HEADCOUNT_SPECIALIZATIONS = ["listing", "buyer", "luxury", "investor", "general"] as const
export type HeadcountSpecialization = (typeof HEADCOUNT_SPECIALIZATIONS)[number]

/** Named changes an owner can ask about. Percentages are relative to the twin's current reading. */
export interface ScenarioLevers {
  /** Seller-side lead acquisition, % change (+30 = "increase seller lead acquisition 30%"). */
  seller_lead_acquisition_pct?: number
  buyer_lead_acquisition_pct?: number
  /** Paid acquisition spend, % change against the trailing-30-day spend (territory_metrics.total_cost). */
  ad_spend_pct?: number
  /** Agents added (+) / removed (−) by specialization. */
  agent_headcount?: Partial<Record<HeadcountSpecialization, number>>
  /** Nurture campaign touch cadence, % change. */
  campaign_cadence_pct?: number
  /** Territories (farm_territories.name, as the twin names them) the seller lift is aimed at. Absent =
   *  the lift applies brokerage-wide; present = only these territories receive it. */
  territory_activation?: string[]
  /** AI ISA qualification capacity, % change. */
  isa_capacity_pct?: number
}

export const SCENARIO_LEVER_KEYS = [
  "seller_lead_acquisition_pct", "buyer_lead_acquisition_pct", "ad_spend_pct", "agent_headcount",
  "campaign_cadence_pct", "territory_activation", "isa_capacity_pct",
] as const
type ScenarioLeverKey = (typeof SCENARIO_LEVER_KEYS)[number]

/** Levers a saturation search can sweep (scalar % levers), in priority order. */
const SWEEPABLE: ReadonlyArray<"seller_lead_acquisition_pct" | "buyer_lead_acquisition_pct" | "ad_spend_pct" | "campaign_cadence_pct"> = [
  "seller_lead_acquisition_pct", "buyer_lead_acquisition_pct", "ad_spend_pct", "campaign_cadence_pct",
]

export const SCENARIO_PROPAGATION_CHAIN = [
  "seller_demand", "buyer_demand", "ai_isa_capacity", "agent_capacity", "competency_coverage", "territories",
  "campaign_and_ads", "media", "transaction_capacity", "revenue", "fatigue",
] as const
export type ScenarioStage = (typeof SCENARIO_PROPAGATION_CHAIN)[number]

// ─── Coefficients + contributors ─────────────────────────────────────────────

export type CoefficientConfidence = "high" | "medium" | "low" | "assumed"

export interface ScenarioCoefficient {
  key: string
  value: number
  unit: string
  /** Where the number came from: a twin field, a tenant policy key, a ledger, or "assumption: …". */
  source: string
  confidence: CoefficientConfidence
  /** True when no input backed the value — it is a named assumption, never a silent default. */
  assumption: boolean
  manager: ManagerKey
}

/** Inputs the twin does not carry, read by loadScenarioFacts (null = not read / refused → assumption). */
export interface ScenarioFacts {
  /** territory_metrics, trailing 30 days (lib/territory/metrics-aggregator.ts is the writer). */
  marketing: { leads30d: number; spendUsd30d: number; rows: number } | null
  /** users at user_type='tc' (the transaction-coordinator seat) for the tenant. */
  txDeskStaff: number | null
  /** lib/kernel/media-intelligence.ts GENERATION_COST_ESTIMATE_USD, handed in by the caller. */
  mediaCostUsd: Readonly<Record<string, number>> | null
  /** lib/kernel/media-intelligence.ts MAX_MEDIA_VARIANTS (ad-creative variants per need). */
  mediaVariants: number | null
  /** Reads that refused (named; the coefficient they fed becomes an assumption). */
  refused: string[]
}

export const EMPTY_SCENARIO_FACTS: ScenarioFacts = { marketing: null, txDeskStaff: null, mediaCostUsd: null, mediaVariants: null, refused: [] }

export interface ScenarioContributor {
  manager: ManagerKey
  /** The stages of SCENARIO_PROPAGATION_CHAIN this domain supplies coefficients for. */
  stages: ScenarioStage[]
  coefficients: (twin: BrokerageTwin, facts: ScenarioFacts) => ScenarioCoefficient[]
  risks?: (twin: BrokerageTwin, levers: ScenarioLevers) => string[]
}

const confidenceOf = (n: number): CoefficientConfidence => (n >= 20 ? "high" : n >= 5 ? "medium" : "low")
const coef = (manager: ManagerKey, key: string, value: number, unit: string, source: string, confidence: CoefficientConfidence): ScenarioCoefficient =>
  ({ key, value, unit, source, confidence, assumption: confidence === "assumed", manager })
const assumed = (manager: ManagerKey, key: string, value: number, unit: string, why: string): ScenarioCoefficient =>
  coef(manager, key, value, unit, `assumption: ${why}`, "assumed")

const sellerLeadsFromTerritories = (t: BrokerageTwin) => (t.workforce?.territories ?? []).reduce((a, d) => a + d.sellerLeads30d, 0)

/**
 * THE REGISTRY — one pure contributor per manager domain (keyed by MANAGERS). Every coefficient a
 * projection uses comes from exactly one of these, carrying its source and confidence.
 */
export const SCENARIO_CONTRIBUTORS: Readonly<Partial<Record<ManagerKey, ScenarioContributor>>> = {
  listing_concierge: {
    manager: "listing_concierge", stages: ["seller_demand", "territories"],
    coefficients: (t) => {
      const terr = t.workforce?.territories ?? []
      const seller = sellerLeadsFromTerritories(t)
      const out: ScenarioCoefficient[] = []
      out.push(terr.length && seller > 0
        ? coef("listing_concierge", "base_seller_leads_30d", seller, "leads/30d", "twin.workforce.territories[].sellerLeads30d (leads lead_type∈{seller,both})", confidenceOf(seller))
        : assumed("listing_concierge", "base_seller_leads_30d", Math.round((t.now.pipeline.leads * 0.4) / 3), "leads/30d", "no territory seller-lead reading — 40% of the active lead base is seller-side, turning over quarterly"))
      out.push(assumed("listing_concierge", "listing_take_rate", 0.5, "listings per converted seller", "half of converted seller leads list within the horizon (no seller-lead→listing join in the twin)"))
      const active = terr.filter((d) => d.sellerLeads30d > 0)
      out.push(active.length
        ? coef("listing_concierge", "avg_territory_seller_leads_30d", seller / active.length, "leads/30d", "twin.workforce.territories (mean over territories with demand)", confidenceOf(active.length))
        : assumed("listing_concierge", "avg_territory_seller_leads_30d", 5, "leads/30d", "a newly activated territory yields the policy minimum demand (demand_min_leads_30d default)"))
      return out
    },
  },
  shopping_agent: {
    manager: "shopping_agent", stages: ["buyer_demand"],
    coefficients: (t) => {
      const seller = sellerLeadsFromTerritories(t)
      return [assumed("shopping_agent", "base_buyer_leads_30d", Math.max(0, Math.round(t.now.pipeline.leads / 3) - seller), "leads/30d", "the twin carries no buyer-lead count — the active lead base turning over quarterly, less the seller reading")]
    },
  },
  ai_isa: {
    manager: "ai_isa", stages: ["ai_isa_capacity"],
    coefficients: (t) => {
      const leads = t.now.pipeline.leads, conv = t.now.pipeline.converted90d
      return [
        leads > 0 && conv > 0
          ? coef("ai_isa", "lead_conversion_rate", conv / (conv + leads), "conversions per lead", "twin.now.pipeline.converted90d ÷ (converted90d + active leads)", confidenceOf(conv))
          : assumed("ai_isa", "lead_conversion_rate", 0.08, "conversions per lead", "no converted leads in the trailing 90 days"),
        assumed("ai_isa", "isa_capacity_leads_30d", Math.max(30, Math.round((leads / 3) * 1.5)), "leads/30d", "the AI ISA qualifies 1.5× the current monthly lead flow before its human-escalation queue saturates (no ISA throughput meter yet)"),
        assumed("ai_isa", "overflow_conversion_factor", 0.3, "× conversion", "leads beyond ISA capacity convert at 30% of the qualified rate (no speed-to-lead decay curve in the twin)"),
      ]
    },
  },
  recruiting_manager: {
    manager: "recruiting_manager", stages: ["agent_capacity", "competency_coverage"],
    coefficients: (t) => {
      const w = t.workforce
      const per = w?.thresholds.seller_leads_per_agent_30d
      return [
        coef("recruiting_manager", "agent_headroom_items", t.capacity.headroom, "items", "twin.capacity.headroom (capacityFor per agent)", confidenceOf(t.capacity.perAgent.length)),
        coef("recruiting_manager", "max_load_per_agent", t.capacity.maxLoad, "items/agent", "twin.capacity.maxLoad (tierMaxLoadForAgentCount)", "high"),
        per ? coef("recruiting_manager", "seller_leads_per_listing_agent_30d", per, "leads/agent/30d", `tenant policy ${w?.thresholdsSource === "policy" ? "brokerage_settings.workforce_thresholds" : "DEFAULT_WORKFORCE_THRESHOLDS"}.seller_leads_per_agent_30d`, w?.thresholdsSource === "policy" ? "high" : "medium")
          : assumed("recruiting_manager", "seller_leads_per_listing_agent_30d", 8, "leads/agent/30d", "no workforce thresholds in the twin"),
        assumed("recruiting_manager", "buyer_leads_per_buyer_agent_30d", Math.round((per ?? 8) * 1.5), "leads/agent/30d", "a buyer agent carries 1.5× the listing-agent seller-lead policy"),
        coef("recruiting_manager", "strong_listing_agents", w?.totals.strong_listing ?? 0, "agents", "twin.workforce.totals.strong_listing", w ? "high" : "low"),
        coef("recruiting_manager", "strong_buyer_agents", w?.totals.strong_buyer ?? 0, "agents", "twin.workforce.totals.strong_buyer", w ? "high" : "low"),
        assumed("recruiting_manager", "generalist_coverage_factor", 0.5, "× specialist", "an agent with headroom but no specialist classification carries half a specialist's demand"),
      ]
    },
  },
  ads_manager: {
    manager: "ads_manager", stages: ["campaign_and_ads"],
    coefficients: (_t, f) => {
      const m = f.marketing
      const ok = m && m.leads30d > 0 && m.spendUsd30d > 0
      return [
        ok ? coef("ads_manager", "marginal_cost_per_lead_usd", m!.spendUsd30d / m!.leads30d, "usd/lead", "territory_metrics.total_cost ÷ lead_count, trailing 30d (lib/territory/metrics-aggregator.ts)", confidenceOf(m!.leads30d))
          : assumed("ads_manager", "marginal_cost_per_lead_usd", 45, "usd/lead", f.refused.some((r) => r.startsWith("territory_metrics")) ? "territory_metrics read refused — a Gulf-Coast paid-lead CPL" : "no attributed spend in territory_metrics — a Gulf-Coast paid-lead CPL"),
        m ? coef("ads_manager", "ad_spend_usd_30d", m.spendUsd30d, "usd/30d", "territory_metrics.total_cost, trailing 30d", confidenceOf(m.rows))
          : assumed("ads_manager", "ad_spend_usd_30d", 0, "usd/30d", "no territory_metrics rows — no measured paid spend to scale"),
        assumed("ads_manager", "spend_elasticity", 0.8, "lead response per spend", "diminishing returns: each added dollar buys 80% of the average lead"),
      ]
    },
    risks: (_t, l) => (l.ad_spend_pct && l.ad_spend_pct > 0 ? ["Paid housing ads run in the special ad category: ZIP / territory targeting may not proxy a protected class (Fair Housing) — compliance review before any campaign."] : []),
  },
  campaign_orchestrator: {
    manager: "campaign_orchestrator", stages: ["campaign_and_ads", "fatigue"],
    coefficients: () => [
      assumed("campaign_orchestrator", "touches_per_contact_30d", 4, "touches/contact/30d", "a nurture sequence touches each active contact weekly"),
      assumed("campaign_orchestrator", "cost_per_touch_usd", 0.02, "usd/touch", "blended email/SMS delivery cost"),
      assumed("campaign_orchestrator", "cadence_fatigue_elasticity", 1.0, "× cadence change", "contact fatigue rises in proportion to touch cadence"),
    ],
  },
  asset_manager: {
    manager: "asset_manager", stages: ["media"],
    coefficients: (_t, f) => {
      const c = f.mediaCostUsd, v = f.mediaVariants
      if (!c) return [assumed("asset_manager", "media_cost_per_listing_usd", 3, "usd/listing", "media cost table not handed in — the 106C lineage at typical generation cost")]
      // 106C lineage per listing: video → social cut → email thumbnail (graphic) → seller campaign (ad creative × variants).
      const variants = v ?? 4
      const perListing = (c.video ?? 0) + (c.social_post ?? 0) + (c.graphic ?? 0) + (c.ad_creative ?? 0) * variants
      return [coef("asset_manager", "media_cost_per_listing_usd", perListing, "usd/listing", `lib/kernel/media-intelligence.ts GENERATION_COST_ESTIMATE_USD over the 106C lineage (video + social_post + graphic + ad_creative × ${variants} variants)`, "medium")]
    },
  },
  deal_coordinator: {
    manager: "deal_coordinator", stages: ["transaction_capacity"],
    coefficients: (t, f) => {
      const staff = f.txDeskStaff
      return [
        staff && staff > 0
          ? coef("deal_coordinator", "deal_desk_capacity_files", staff * 25, "open files", `users user_type='tc' (${staff}) × 25 files each (assumed load per coordinator)`, "medium")
          : assumed("deal_coordinator", "deal_desk_capacity_files", Math.max(4, t.capacity.activeAgents * 4), "open files", "no transaction-coordinator seat — agents carry their own files at 4 each"),
        assumed("deal_coordinator", "escrow_days", 38, "days", "contract-to-close in the Gulf Coast market"),
      ]
    },
  },
  finance_manager: {
    manager: "finance_manager", stages: ["revenue"],
    coefficients: (t) => {
      const e = t.economic, n = t.now
      const out: ScenarioCoefficient[] = []
      out.push(e.closedCount90d > 0 && n.pipeline.converted90d > 0
        ? coef("finance_manager", "close_rate_per_conversion", Math.min(1, e.closedCount90d / n.pipeline.converted90d), "closes per conversion", "twin.economic.closedCount90d ÷ twin.now.pipeline.converted90d", confidenceOf(e.closedCount90d))
        : assumed("finance_manager", "close_rate_per_conversion", 0.2, "closes per conversion", "no closed deals and conversions in the trailing 90 days to divide"))
      out.push(e.closedCount90d > 0
        ? coef("finance_manager", "gci_per_close_cents", e.gciClosed90dCents / e.closedCount90d, "cents/close", "twin.economic.gciClosed90dCents ÷ closedCount90d", confidenceOf(e.closedCount90d))
        : n.transactions.open > 0 && n.transactions.openCommissionCents > 0
          ? coef("finance_manager", "gci_per_close_cents", n.transactions.openCommissionCents / n.transactions.open, "cents/close", "twin.now.transactions.openCommissionCents ÷ open (no closes in 90d)", "low")
          : assumed("finance_manager", "gci_per_close_cents", 900_000, "cents/close", "no closed or open commission in the twin"))
      const leads30 = n.pipeline.leads / 3
      out.push(leads30 > 0 && e.aiCost30dCents > 0
        ? coef("finance_manager", "ai_cost_per_lead_cents", e.aiCost30dCents / leads30, "cents/lead", "twin.economic.aiCost30dCents ÷ (active leads ÷ 3)", "low")
        : assumed("finance_manager", "ai_cost_per_lead_cents", 25, "cents/lead", "no AI cost or lead base in the twin"))
      return out
    },
  },
  sphere_of_influence: {
    manager: "sphere_of_influence", stages: ["fatigue"],
    coefficients: (t) => {
      const fat = t.atRisk.filter((r) => r.kind === "fatigue").reduce((a, r) => a + r.count, 0)
      const active = t.now.contacts.active
      return [
        active > 0 ? coef("sphere_of_influence", "contact_fatigue_share", fat / active, "share", "twin.atRisk[fatigue].count ÷ twin.now.contacts.active (buyer_fatigue_scores high/critical)", confidenceOf(active))
          : assumed("sphere_of_influence", "contact_fatigue_share", 0.05, "share", "no active contacts in the twin"),
        assumed("sphere_of_influence", "contact_fatigue_ceiling", 0.15, "share", "past 15% of contacts at high/critical fatigue the relationship base erodes"),
      ]
    },
  },
  compliance_officer: {
    manager: "compliance_officer", stages: ["campaign_and_ads"],
    coefficients: () => [],
    risks: (t, l) => {
      const open = t.atRisk.filter((r) => r.kind === "compliance").reduce((a, r) => a + r.count, 0)
      return open > 0 && ((l.seller_lead_acquisition_pct ?? 0) > 0 || (l.ad_spend_pct ?? 0) > 0)
        ? [`${open} compliance flag(s) are unresolved — scaling acquisition scales the review queue`] : []
    },
  },
  data_steward: {
    manager: "data_steward", stages: ["seller_demand"],
    coefficients: () => [],
    risks: (t) => (t.blindSpots.length ? [`The twin carries ${t.blindSpots.length} blind spot(s) (${t.blindSpots.slice(0, 2).join("; ")}) — the projection inherits them`] : []),
  },
}

/** PURE: every coefficient the registry yields for this twin (one value per key; first contributor wins). */
function scenarioCoefficients(twin: BrokerageTwin, facts: ScenarioFacts = EMPTY_SCENARIO_FACTS): ScenarioCoefficient[] {
  const out: ScenarioCoefficient[] = []
  const seen = new Set<string>()
  for (const c of Object.values(SCENARIO_CONTRIBUTORS)) {
    if (!c) continue
    for (const k of c.coefficients(twin, facts)) { if (!seen.has(k.key) && Number.isFinite(k.value)) { seen.add(k.key); out.push(k) } }
  }
  return out
}

// ─── Projection ──────────────────────────────────────────────────────────────

export interface ScenarioStageResult {
  stage: ScenarioStage
  manager: ManagerKey
  /** What flows into the stage under the levers (null for a cost-only stage). */
  demand: number | null
  /** What the stage can carry (null = no capacity bound — named in `note`). */
  capacity: number | null
  /** demand ÷ capacity (null when unbounded); ≥ 1 is saturated. */
  utilization: number | null
  saturated: boolean
  unit: string
  /** The coefficient keys this stage read. */
  inputs: string[]
  note?: string
}

export interface ScenarioProjection {
  brokerageId: string
  twinAt: string
  twinDigest: string
  levers: ScenarioLevers
  chain: ScenarioStageResult[]
  opportunityGain: { addedLeads30d: number; addedConversions30d: number; addedListings30d: number; addedCloses30d: number; addedRevenueCents: number }
  staffingConstraint: {
    /** The stage that saturates first (already saturated, or under the levers, or along the sweep). */
    firstSaturated: ScenarioStage | null
    /** The lever value at which it saturates (null when already saturated at no change, or never within the sweep). */
    atLeverValue: number | null
    lever: ScenarioLeverKey | null
    /** Stages saturated under the levers as given. */
    saturatedNow: ScenarioStage[]
    /** Per stage, the swept lever value at which it first saturates (null = not within the sweep). */
    saturationPoints: Partial<Record<ScenarioStage, number | null>>
    /** 104B's scenario() over the agent roster (the capacityFor math) — the agent-capacity evidence. */
    capacityScenario: ScenarioOutput | null
  }
  marketingCost: { acquisitionCents: number; adSpendCents: number; campaignCents: number; mediaCents: number; aiCents: number; totalCents: number }
  expectedMarginCents: number
  risks: string[]
  /** Coefficients that are assumptions or low confidence — published, never hidden. */
  assumptions: ScenarioCoefficient[]
  coefficients: ScenarioCoefficient[]
  /** Lever keys / territories the engine does not understand (returned, never dropped). */
  unsupported: string[]
  blindSpots: string[]
  digest: string
}

const clampPct = (n: unknown) => { const v = Number(n); return Number.isFinite(v) ? Math.max(-100, Math.min(1000, v)) : 0 }

/** PURE: the levers as the engine reads them (unknown keys and bad values reported, never dropped). */
function normalizeLevers(raw: unknown): { levers: ScenarioLevers; unsupported: string[] } {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const unsupported = Object.keys(obj).filter((k) => !(SCENARIO_LEVER_KEYS as readonly string[]).includes(k))
  const levers: ScenarioLevers = {}
  for (const k of ["seller_lead_acquisition_pct", "buyer_lead_acquisition_pct", "ad_spend_pct", "campaign_cadence_pct", "isa_capacity_pct"] as const) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") levers[k] = clampPct(obj[k])
  }
  if (obj.agent_headcount && typeof obj.agent_headcount === "object") {
    const h: Partial<Record<HeadcountSpecialization, number>> = {}
    for (const [k, v] of Object.entries(obj.agent_headcount as Record<string, unknown>)) {
      if (!(HEADCOUNT_SPECIALIZATIONS as readonly string[]).includes(k)) { unsupported.push(`agent_headcount.${k}`); continue }
      const n = Math.trunc(Number(v)); if (Number.isFinite(n) && n !== 0) h[k as HeadcountSpecialization] = Math.max(-500, Math.min(500, n))
    }
    if (Object.keys(h).length) levers.agent_headcount = h
  }
  if (Array.isArray(obj.territory_activation)) {
    const t = [...new Set(obj.territory_activation.map((x) => String(x).trim()).filter(Boolean))].sort()
    if (t.length) levers.territory_activation = t
  }
  return { levers, unsupported }
}

interface Core { chain: ScenarioStageResult[]; gain: ScenarioProjection["opportunityGain"]; cost: ScenarioProjection["marketingCost"]; capacityScenario: ScenarioOutput | null; unsupported: string[] }

function propagate(twin: BrokerageTwin, levers: ScenarioLevers, c: Record<string, ScenarioCoefficient>): Core {
  const v = (k: string) => c[k]?.value ?? 0
  const pct = (n: number | undefined) => (n ?? 0) / 100
  const unsupported: string[] = []
  const chain: ScenarioStageResult[] = []
  const stage = (s: Omit<ScenarioStageResult, "utilization" | "saturated">) => {
    const utilization = s.capacity === null || s.demand === null ? null : s.capacity > 0 ? s.demand / s.capacity : s.demand > 0 ? Infinity : 0
    chain.push({ ...s, utilization: utilization === null ? null : Number.isFinite(utilization) ? Math.round(utilization * 1000) / 1000 : 999, saturated: utilization !== null && utilization >= 1 })
  }

  // 1 SELLER DEMAND — brokerage-wide lift, or aimed at the activated territories.
  const territories = twin.workforce?.territories ?? []
  const sellerBase = v("base_seller_leads_30d")
  let sellerLift = sellerBase * pct(levers.seller_lead_acquisition_pct)
  const liftByTerritory = new Map<string, number>()
  if (levers.territory_activation?.length) {
    sellerLift = 0
    for (const name of levers.territory_activation) {
      const d = territories.find((x) => x.territory === name)
      if (!d) { unsupported.push(`territory_activation:${name}`); continue }
      // An activated territory with no demand yet opens at the average territory's demand.
      const lift = d.sellerLeads30d > 0 ? d.sellerLeads30d * pct(levers.seller_lead_acquisition_pct) : v("avg_territory_seller_leads_30d") * Math.max(1, 1 + pct(levers.seller_lead_acquisition_pct))
      liftByTerritory.set(name, lift); sellerLift += lift
    }
  } else if (sellerBase > 0) {
    for (const d of territories) liftByTerritory.set(d.territory, d.sellerLeads30d * pct(levers.seller_lead_acquisition_pct))
  }
  const buyerBase = v("base_buyer_leads_30d")
  const buyerLift = buyerBase * pct(levers.buyer_lead_acquisition_pct)
  // Paid leads from a spend change, split by the base seller/buyer mix.
  const spend = v("ad_spend_usd_30d"), cpl = v("marginal_cost_per_lead_usd")
  const spendDelta = spend * pct(levers.ad_spend_pct)
  const adLeads = cpl > 0 ? (spendDelta / cpl) * (spendDelta > 0 ? v("spend_elasticity") : 1) : 0
  const sellerShare = sellerBase + buyerBase > 0 ? sellerBase / (sellerBase + buyerBase) : 0.5
  const addedSeller = sellerLift + adLeads * sellerShare
  const addedBuyer = buyerLift + adLeads * (1 - sellerShare)
  stage({ stage: "seller_demand", manager: "listing_concierge", demand: sellerBase + addedSeller, capacity: null, unit: "seller leads/30d", inputs: ["base_seller_leads_30d", "avg_territory_seller_leads_30d"], note: "demand stage — no capacity bound" })
  stage({ stage: "buyer_demand", manager: "shopping_agent", demand: buyerBase + addedBuyer, capacity: null, unit: "buyer leads/30d", inputs: ["base_buyer_leads_30d"], note: "demand stage — no capacity bound" })

  // 2 AI ISA CAPACITY — qualified throughput; overflow converts at a reduced rate.
  const baseLeads = sellerBase + buyerBase, totalLeads = Math.max(0, baseLeads + addedSeller + addedBuyer)
  const isaCap = v("isa_capacity_leads_30d") * Math.max(0, 1 + pct(levers.isa_capacity_pct))
  stage({ stage: "ai_isa_capacity", manager: "ai_isa", demand: totalLeads, capacity: isaCap, unit: "leads/30d", inputs: ["isa_capacity_leads_30d"] })
  const conv = v("lead_conversion_rate"), overflow = v("overflow_conversion_factor")
  const converted = (leads: number) => Math.min(leads, isaCap) * conv + Math.max(0, leads - isaCap) * conv * overflow
  const addedConversions = converted(totalLeads) - converted(baseLeads)

  // 3 AGENT CAPACITY — the survivor's scenario() (computeCapacity over the roster) for the bands;
  // the stage compares new book items against the roster's headroom + added agents' ceilings.
  const hc = levers.agent_headcount ?? {}
  const agentsDelta = Object.values(hc).reduce((a, n) => a + (n ?? 0), 0)
  const loadTotal = twin.capacity.perAgent.reduce((a, p) => a + p.load, 0)
  let capacityScenario: ScenarioOutput | null = null
  if (twin.capacity.perAgent.length > 0) {
    const deltas = { activeAgentsDelta: agentsDelta, ...(loadTotal > 0 ? { loadPerAgentPct: Math.round((addedConversions / loadTotal) * 1000) / 10 } : {}) }
    capacityScenario = scenario(twin, deltas).outputs.find((o) => o.field === "capacity") ?? null
  }
  const agentCap = Math.max(0, v("agent_headroom_items") + agentsDelta * v("max_load_per_agent"))
  stage({ stage: "agent_capacity", manager: "recruiting_manager", demand: Math.max(0, addedConversions), capacity: agentCap, unit: "new book items", inputs: ["agent_headroom_items", "max_load_per_agent"], note: capacityScenario ? `scenario() bands: ${capacityScenario.status === "ok" ? JSON.stringify(capacityScenario.value) : capacityScenario.reason}` : "no scored agents — scenario() not run" })

  // 4 COMPETENCY COVERAGE — specialists (+ hires) and generalists with headroom vs seller + buyer demand.
  const headroomAgents = twin.capacity.perAgent.filter((p) => p.band === "available" || p.band === "busy").length
  const listingSpec = v("strong_listing_agents") + (hc.listing ?? 0) + (hc.luxury ?? 0)
  const buyerSpec = v("strong_buyer_agents") + (hc.buyer ?? 0) + (hc.investor ?? 0)
  const generalists = Math.max(0, headroomAgents - v("strong_listing_agents") - v("strong_buyer_agents")) + (hc.general ?? 0)
  const g = v("generalist_coverage_factor") * generalists
  const listingCap = Math.max(0, listingSpec + g / 2) * v("seller_leads_per_listing_agent_30d")
  const buyerCap = Math.max(0, buyerSpec + g / 2) * v("buyer_leads_per_buyer_agent_30d")
  const sellerDemand = sellerBase + addedSeller, buyerDemand = buyerBase + addedBuyer
  const listingUtil = listingCap > 0 ? sellerDemand / listingCap : sellerDemand > 0 ? Infinity : 0
  const buyerUtil = buyerCap > 0 ? buyerDemand / buyerCap : buyerDemand > 0 ? Infinity : 0
  const tight = listingUtil >= buyerUtil
  stage({ stage: "competency_coverage", manager: "recruiting_manager", demand: tight ? sellerDemand : buyerDemand, capacity: tight ? listingCap : buyerCap, unit: tight ? "seller leads/30d (listing coverage)" : "buyer leads/30d (buyer coverage)", inputs: ["strong_listing_agents", "strong_buyer_agents", "generalist_coverage_factor", "seller_leads_per_listing_agent_30d", "buyer_leads_per_buyer_agent_30d"] })

  // 5 TERRITORIES — each territory's seller demand vs its serving agents with headroom; listing /
  // luxury hires are placed greedily on the worst territory (deterministic: name order breaks ties).
  const per = v("seller_leads_per_listing_agent_30d")
  const rows = territories.map((d) => ({ name: d.territory, demand: d.sellerLeads30d + (liftByTerritory.get(d.territory) ?? 0), agents: d.agentsWithHeadroom }))
  let hires = Math.max(0, (hc.listing ?? 0) + (hc.luxury ?? 0))
  const util = (r: { demand: number; agents: number }) => (r.agents * per > 0 ? r.demand / (r.agents * per) : r.demand > 0 ? Infinity : 0)
  while (hires > 0 && rows.length) {
    const worst = [...rows].sort((a, b) => util(b) - util(a) || a.name.localeCompare(b.name))[0]
    worst.agents += 1; hires--
  }
  const worst = [...rows].sort((a, b) => util(b) - util(a) || a.name.localeCompare(b.name))[0]
  stage(worst
    ? { stage: "territories", manager: "listing_concierge", demand: worst.demand, capacity: worst.agents * per, unit: `seller leads/30d in ${worst.name}`, inputs: ["seller_leads_per_listing_agent_30d"], note: `tightest of ${rows.length} territor${rows.length === 1 ? "y" : "ies"}: ${worst.name} (${worst.agents} serving agent(s) with headroom)` }
    : { stage: "territories", manager: "listing_concierge", demand: null, capacity: null, unit: "seller leads/30d", inputs: [], note: "no farm territories in the twin — territory saturation not assessable" })

  // 6 CAMPAIGN + ADS — marginal cost per lead for acquisition, the spend delta, nurture touches.
  const acquisitionCents = Math.round((sellerLift + buyerLift) * cpl * 100)
  const adSpendCents = Math.round(spendDelta * 100)
  const touches = v("touches_per_contact_30d"), touchCost = v("cost_per_touch_usd")
  const cadence = 1 + pct(levers.campaign_cadence_pct)
  const campaignCents = Math.round(((Math.max(0, addedConversions) * touches * cadence) + twin.now.contacts.active * touches * pct(levers.campaign_cadence_pct)) * touchCost * 100)
  stage({ stage: "campaign_and_ads", manager: "ads_manager", demand: null, capacity: null, unit: "cost", inputs: ["marginal_cost_per_lead_usd", "ad_spend_usd_30d", "spend_elasticity", "touches_per_contact_30d", "cost_per_touch_usd"], note: "cost stage — budget, not throughput" })

  // 7 MEDIA — the 106C lineage per new listing (generated media has no throughput bound).
  const addedListings = Math.max(0, addedSeller * conv * v("listing_take_rate"))
  const mediaCents = Math.round(addedListings * v("media_cost_per_listing_usd") * 100)
  stage({ stage: "media", manager: "asset_manager", demand: addedListings, capacity: null, unit: "new listings needing a lineage", inputs: ["listing_take_rate", "media_cost_per_listing_usd"], note: "generated media — cost-bound, not throughput-bound (photography is a vendor booking, not modelled)" })

  // 8 TRANSACTION CAPACITY — added closes held open for the escrow period vs the desk.
  const addedCloses = Math.max(0, addedConversions) * v("close_rate_per_conversion")
  const addedOpen = addedCloses * (v("escrow_days") / 30)
  stage({ stage: "transaction_capacity", manager: "deal_coordinator", demand: twin.now.transactions.open + addedOpen, capacity: v("deal_desk_capacity_files"), unit: "open files", inputs: ["deal_desk_capacity_files", "escrow_days", "close_rate_per_conversion"] })

  // 9 REVENUE — the twin's own stage conversion × GCI per close.
  const addedRevenueCents = Math.round(addedCloses * v("gci_per_close_cents"))
  stage({ stage: "revenue", manager: "finance_manager", demand: null, capacity: null, unit: "cents", inputs: ["close_rate_per_conversion", "gci_per_close_cents"], note: "outcome stage" })

  // 10 FATIGUE — contact fatigue share under the cadence change vs the ceiling.
  const share = v("contact_fatigue_share") * (1 + pct(levers.campaign_cadence_pct) * v("cadence_fatigue_elasticity"))
  stage({ stage: "fatigue", manager: "sphere_of_influence", demand: Math.max(0, share), capacity: v("contact_fatigue_ceiling"), unit: "share of contacts high/critical", inputs: ["contact_fatigue_share", "contact_fatigue_ceiling", "cadence_fatigue_elasticity"] })

  const aiCents = Math.round(Math.max(0, addedSeller + addedBuyer) * v("ai_cost_per_lead_cents"))
  const totalCents = acquisitionCents + adSpendCents + campaignCents + mediaCents + aiCents
  return {
    chain, capacityScenario, unsupported,
    gain: { addedLeads30d: round1(addedSeller + addedBuyer), addedConversions30d: round1(addedConversions), addedListings30d: round1(addedListings), addedCloses30d: round1(addedCloses), addedRevenueCents },
    cost: { acquisitionCents, adSpendCents, campaignCents, mediaCents, aiCents, totalCents },
  }
}
const round1 = (n: number) => Math.round(n * 10) / 10

/** The sweep: lever values tried when searching for the first saturating stage. */
export const SATURATION_SWEEP_STEP = 5
export const SATURATION_SWEEP_MAX = 500

/**
 * PURE + DETERMINISTIC: project a lever change through the twin's system flows. The twin is the
 * only read model; every coefficient names its source and confidence; nothing is written.
 * `simulateScenario({ brokerageId, levers }, twin, facts)` — the twin MUST be the caller's tenant's
 * (a foreign twin is refused, never projected).
 */
export function simulateScenario(input: { brokerageId: string; levers: unknown }, twin: BrokerageTwin, facts: ScenarioFacts = EMPTY_SCENARIO_FACTS): ScenarioProjection {
  if (!input.brokerageId || twin.brokerageId !== input.brokerageId) throw new Error("twin-scenario: the twin is not this tenant's (resolve brokerageId from the session)")
  const { levers, unsupported: badKeys } = normalizeLevers(input.levers)
  const coefficients = scenarioCoefficients(twin, facts)
  const byKey = Object.fromEntries(coefficients.map((k) => [k.key, k]))
  const core = propagate(twin, levers, byKey)

  // SATURATION — sweep the primary lever (the first scalar lever given; seller acquisition when none).
  const lever = SWEEPABLE.find((k) => levers[k] !== undefined && levers[k] !== 0) ?? "seller_lead_acquisition_pct"
  const saturationPoints: Partial<Record<ScenarioStage, number | null>> = {}
  const max = Math.max(SATURATION_SWEEP_MAX, Math.ceil((levers[lever] ?? 0) / SATURATION_SWEEP_STEP) * SATURATION_SWEEP_STEP)
  for (const s of core.chain) if (s.utilization !== null) saturationPoints[s.stage] = null
  for (let x = 0; x <= max; x += SATURATION_SWEEP_STEP) {
    const sweep = propagate(twin, { ...levers, [lever]: x }, byKey)
    for (const s of sweep.chain) if (s.saturated && saturationPoints[s.stage] === null) saturationPoints[s.stage] = x
    if (Object.values(saturationPoints).every((p) => p !== null)) break
  }
  const saturatedNow = core.chain.filter((s) => s.saturated).map((s) => s.stage)
  const ranked = (Object.entries(saturationPoints) as Array<[ScenarioStage, number | null]>).filter(([, p]) => p !== null)
    .sort((a, b) => (a[1]! - b[1]!) || SCENARIO_PROPAGATION_CHAIN.indexOf(a[0]) - SCENARIO_PROPAGATION_CHAIN.indexOf(b[0]))
  const firstSaturated = ranked[0]?.[0] ?? saturatedNow[0] ?? null
  const atLeverValue = ranked[0] ? ranked[0][1] : null

  // RISKS — saturation, fatigue, assumption load, and each domain contributor's own.
  const risks: string[] = []
  for (const s of core.chain.filter((x) => x.saturated)) risks.push(`${s.stage.replace(/_/g, " ")} saturates under these levers (${s.utilization}× capacity, ${s.unit}) — owned by ${s.manager}`)
  if (firstSaturated && atLeverValue !== null) risks.push(`${firstSaturated.replace(/_/g, " ")} is the first stage to saturate, at ${lever} = ${atLeverValue}%`)
  if ((core.capacityScenario?.status === "ok") && typeof core.capacityScenario.value === "object" && core.capacityScenario.value) {
    const b = core.capacityScenario.value as Record<string, number>
    if ((b.over ?? 0) > 0) risks.push(`${b.over} agent(s) land in the 'over' capacity band (agent fatigue — computeCapacity)`)
  }
  for (const c of Object.values(SCENARIO_CONTRIBUTORS)) if (c?.risks) risks.push(...c.risks(twin, levers))
  const assumptions = coefficients.filter((k) => k.assumption || k.confidence === "low")
  if (assumptions.length) risks.push(`${assumptions.length} of ${coefficients.length} coefficients are assumptions or low-confidence — read them before acting`)

  const unsupported = [...badKeys, ...core.unsupported]
  const digest = twinDigest({
    ...Object.fromEntries(coefficients.map((k) => [`c.${k.key}`, k.value])),
    ...leverMeasures(levers),
    "p.gain": core.gain.addedRevenueCents, "p.cost": core.cost.totalCents,
    [`t.${twin.digest}`]: 1,
  })
  return {
    brokerageId: twin.brokerageId, twinAt: twin.at, twinDigest: twin.digest, levers,
    chain: core.chain, opportunityGain: core.gain,
    staffingConstraint: { firstSaturated, atLeverValue, lever: firstSaturated ? lever : null, saturatedNow, saturationPoints, capacityScenario: core.capacityScenario },
    marketingCost: core.cost,
    expectedMarginCents: core.gain.addedRevenueCents - core.cost.totalCents,
    risks, assumptions, coefficients, unsupported, blindSpots: [...twin.blindSpots], digest,
  }
}

/** PURE: the levers as flat numeric measures (the projection digest, which keys the ledger evidence row). */
function leverMeasures(levers: ScenarioLevers): Record<string, number> {
  const m: Record<string, number> = {}
  for (const [k, x] of Object.entries(levers)) {
    if (typeof x === "number") m[`l.${k}`] = x
    else if (Array.isArray(x)) for (const t of x) m[`l.${k}.${t}`] = 1
    else if (x && typeof x === "object") for (const [s, n] of Object.entries(x)) m[`l.${k}.${s}`] = Number(n)
  }
  return m
}

/** PURE: the one-line reading of a projection (the Command Center card + mission objective). */
export function scenarioHeadline(p: ScenarioProjection): string {
  const usd = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`
  const constraint = p.staffingConstraint.firstSaturated
    ? `${p.staffingConstraint.firstSaturated.replace(/_/g, " ")} saturates first${p.staffingConstraint.atLeverValue !== null ? ` at ${p.staffingConstraint.lever} = ${p.staffingConstraint.atLeverValue}%` : " (already at capacity)"}`
    : "no stage saturates within the sweep"
  return `+${p.opportunityGain.addedLeads30d} leads/30d → +${p.opportunityGain.addedCloses30d} closes, ${usd(p.opportunityGain.addedRevenueCents)} GCI vs ${usd(p.marketingCost.totalCents)} cost (margin ${usd(p.expectedMarginCents)}); ${constraint}`
}

// ─── Facts loader (READS ONLY; every read pinned to the tenant; refusals named) ─

export async function loadScenarioFacts(svc: Svc, brokerageId: string, at: Date = new Date()): Promise<ScenarioFacts> {
  if (!brokerageId) throw new Error("twin-scenario: brokerageId is required (resolve it from the session)")
  const refused: string[] = []
  const since = new Date(at.getTime() - 30 * 86_400_000).toISOString().slice(0, 10)
  const [tm, tc] = await Promise.all([
    svc.from("territory_metrics").select("lead_count, total_cost, metric_date").eq("brokerage_id", brokerageId).gte("metric_date", since).limit(5000),
    svc.from("users").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("user_type", "tc"),
  ])
  let marketing: ScenarioFacts["marketing"] = null
  if (tm.error) refused.push(`territory_metrics: ${tm.error.message}`)
  else {
    const rows = (tm.data ?? []) as Array<{ lead_count: number | null; total_cost: number | null }>
    if (rows.length) marketing = { rows: rows.length, leads30d: rows.reduce((a, r) => a + (Number(r.lead_count) || 0), 0), spendUsd30d: rows.reduce((a, r) => a + (Number(r.total_cost) || 0), 0) }
  }
  let txDeskStaff: number | null = null
  if (tc.error) refused.push(`users(tc): ${tc.error.message}`)
  else txDeskStaff = tc.count ?? 0
  return { marketing, txDeskStaff, mediaCostUsd: null, mediaVariants: null, refused }
}
