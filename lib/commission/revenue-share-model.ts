// lib/commission/revenue-share-model.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE REVENUE-SHARE DISTRIBUTION MODEL — settings the platform READS, never
// assumes (owner ruling 2026-08-27, verbatim: "revenue share mark should not be
// created with any assumption of how it gets configured so the settings should
// be telling the platform how the revenue share gets distributed whether it is
// a portion of the income or the brokerage pays the share as a flat fee or %
// and duration. platform should not make assumption even with referrals.").
//
// The model lives on the brokerages row (m575 — WRITTEN, integrator applies):
//   SOURCE   revenue_share_source_of_funds  'agent' | 'brokerage'
//            (the same vocabulary as agent_relationships.source_of_funds, §6)
//   RATE     revenue_share_rate_type        'percent' | 'flat'
//            + revenue_share_default_percent / revenue_share_flat_cents.
//            'flat' is cents PER CLOSING: the waterfall runs once per
//            transaction — there is no per-period runner on the commission
//            rail, so that is the only duration a flat share can have.
//   DURATION revenue_share_duration_months  0 = indefinite (EXPLICIT),
//            N = months; stamped as effective_to on NEW edges only. Existing
//            edges keep their stamped window — a model change is never
//            retroactive (the m573 fee_percent denormalization precedent).
//
// FAIL-CLOSED: NULL anywhere = unconfigured, and unconfigured means the
// revenue_share_enabled mark ALONE pays nothing — the waterfall step no-ops
// (skip reason recorded on the context, warned, never silent) and the
// relationship-creation writer plants NO edge. Readers use select("*") so the
// SAME code is correct before m575 is applied (absent column → undefined →
// unconfigured) — the getReferralFeeTerms idiom, not a 42703 refusal.
//
// The EDGE stays the record of its own terms (revenue_share_percent OR
// revenue_share_flat_cents + source_of_funds + effective window), stamped from
// the model at creation. The model is the brokerage's POLICY: the gate on
// whether anything pays at all, and the template new edges receive.

import { createServiceClient } from "@/lib/supabase/service"
import type { DistributionRecord, CompanyObligationRecord } from "./types"

type Svc = ReturnType<typeof createServiceClient>

/** ONE vocabulary (§6): mirrors agent_relationships.source_of_funds's live CHECK. */
export const REVENUE_SHARE_SOURCES = ["agent", "brokerage"] as const
export type RevenueShareSource = (typeof REVENUE_SHARE_SOURCES)[number]

/** ONE vocabulary (§6): the repo's rate-type pair (commission_distributions.calculation_type). */
export const REVENUE_SHARE_RATE_TYPES = ["percent", "flat"] as const
export type RevenueShareRateType = (typeof REVENUE_SHARE_RATE_TYPES)[number]

export interface RevenueShareModel {
  /** Whose money funds the share: a portion of the agent's income, or the brokerage pays. */
  sourceOfFunds: RevenueShareSource
  rateType: RevenueShareRateType
  /** Default % stamped onto new edges when rateType='percent'. */
  defaultPercent: number | null
  /** Flat cents per closing stamped onto new edges when rateType='flat'. */
  flatCents: number | null
  /** Months a new edge's share runs; 0 = indefinite (an explicit choice). */
  durationMonths: number
}

export interface RevenueShareModelState {
  /** brokerages.revenue_share_enabled — the m264 opt-in mark. */
  enabled: boolean
  /** True only when every piece of the model is present and coherent. */
  configured: boolean
  model: RevenueShareModel | null
  /** What is unconfigured/failed, published beside the verdict — never guessed. */
  missing: string[]
}

/**
 * PURE: read the model off a brokerages row (raw column names). Absent columns
 * (pre-m575) parse exactly like NULLs: unconfigured, fail-closed.
 */
export function parseRevenueShareModel(row: Record<string, unknown> | null | undefined): RevenueShareModelState {
  const enabled = (row as Record<string, unknown> | null | undefined)?.revenue_share_enabled === true
  const missing: string[] = []
  if (!row) {
    return { enabled: false, configured: false, model: null, missing: ["brokerage_row"] }
  }

  const source = row.revenue_share_source_of_funds
  const rateType = row.revenue_share_rate_type
  const pct = Number(row.revenue_share_default_percent)
  const flat = Number(row.revenue_share_flat_cents)
  // NULL/absent must NOT collapse into the explicit 0 (Number(null) === 0):
  // 0 is "indefinite, chosen"; absence is "unconfigured, pay nothing".
  const durationRaw = row.revenue_share_duration_months
  const duration = durationRaw === null || durationRaw === undefined ? Number.NaN : Number(durationRaw)

  if (!REVENUE_SHARE_SOURCES.includes(source as RevenueShareSource)) missing.push("revenue_share_source_of_funds")
  if (!REVENUE_SHARE_RATE_TYPES.includes(rateType as RevenueShareRateType)) missing.push("revenue_share_rate_type")
  if (rateType === "percent" && !(Number.isFinite(pct) && pct > 0 && pct <= 100)) missing.push("revenue_share_default_percent")
  if (rateType === "flat" && !(Number.isInteger(flat) && flat > 0)) missing.push("revenue_share_flat_cents")
  if (!(Number.isInteger(duration) && duration >= 0)) missing.push("revenue_share_duration_months")

  if (missing.length > 0) return { enabled, configured: false, model: null, missing }
  return {
    enabled,
    configured: true,
    missing: [],
    model: {
      sourceOfFunds: source as RevenueShareSource,
      rateType: rateType as RevenueShareRateType,
      defaultPercent: rateType === "percent" ? pct : null,
      flatCents: rateType === "flat" ? flat : null,
      durationMonths: duration,
    },
  }
}

/**
 * Load the model for a brokerage. select("*") deliberately — naming the m575
 * columns in a select would be a hard 42703 refusal until the migration is
 * applied; reading the row whole makes the SAME code correct before and after
 * (absent column → undefined → unconfigured, published in `missing`). The
 * getReferralFeeTerms idiom (lib/platform/referral-payouts.ts).
 * A refused read FAILS CLOSED: enabled=false, nothing pays — and says why.
 */
export async function getRevenueShareModel(brokerageId: string, client?: Svc): Promise<RevenueShareModelState> {
  const svc = client ?? createServiceClient()
  const { data, error } = await svc
    .from("brokerages")
    .select("*")
    .eq("id", brokerageId)
    .maybeSingle()
  // §3: supabase-js RESOLVES refusals — the error is read, never discarded.
  if (error) {
    return { enabled: false, configured: false, model: null, missing: [`read_failed: ${error.message}`] }
  }
  return parseRevenueShareModel((data ?? null) as Record<string, unknown> | null)
}

/** YYYY-MM-DD, `months` months after `from` (calendar-clamped by the Date rollover rules). */
function addMonthsDateStr(from: Date, months: number): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, from.getUTCDate()))
  return d.toISOString().slice(0, 10)
}

export interface RevenueShareEdgeTerms {
  revenue_share_percent: number | null
  /** Only present for flat models — the key must be OMITTED from pre-m575 writes
   *  (naming an absent column refuses the whole write, PGRST204 — §3). */
  revenue_share_flat_cents?: number
  source_of_funds: RevenueShareSource
  effective_from: string
  effective_to: string | null
}

/**
 * PURE: the terms a NEW relationship edge receives from the configured model —
 * the one replacement for the hardcoded `revenue_share_percent: 5,
 * source_of_funds: "brokerage"` the provisioning route used to invent.
 * Returns null when the model is not configured: NO edge is planted (fail-closed).
 */
export function edgeTermsFromModel(state: RevenueShareModelState, from: Date = new Date()): RevenueShareEdgeTerms | null {
  if (!state.enabled || !state.configured || !state.model) return null
  const m = state.model
  const effectiveFrom = from.toISOString().slice(0, 10)
  const terms: RevenueShareEdgeTerms = {
    revenue_share_percent: m.rateType === "percent" ? m.defaultPercent : null,
    source_of_funds: m.sourceOfFunds,
    effective_from: effectiveFrom,
    effective_to: m.durationMonths === 0 ? null : addMonthsDateStr(from, m.durationMonths),
  }
  if (m.rateType === "flat" && m.flatCents) terms.revenue_share_flat_cents = m.flatCents
  return terms
}

/** Minimal edge shape the computation needs (agent_relationships row). */
export interface RevenueShareEdge {
  /** agent_relationships.id — the RULE identity a residual share is keyed on (wave 107, 107A). */
  id?: string | null
  sponsor_agent_id: string | null
  relationship_type?: string | null
  depth_level?: number | null
  revenue_share_percent?: number | null
  revenue_share_flat_cents?: number | null
  source_of_funds?: string | null
  effective_from?: string | null
  effective_to?: string | null
  is_active?: boolean | null
}

/**
 * PURE: DURATION enforcement — an edge pays only inside its effective window.
 * Null bounds are open (effective_to null = indefinite, the explicit-0 model).
 * computeRevenueShare applies it (the guard proves the behavior through its
 * window cases); EXPORTED (wave 104, lane 104A) so the economic graph
 * (lib/kernel/economic-graph.ts resolveResidualTree) resolves the residual tree
 * on the EVENT date with the same window rule rather than a second copy (§6).
 */
export function withinEffectiveWindow(edge: Pick<RevenueShareEdge, "effective_from" | "effective_to">, todayStr: string): boolean {
  if (edge.effective_from && edge.effective_from > todayStr) return false
  if (edge.effective_to && edge.effective_to < todayStr) return false
  return true
}

export type RevenueShareSkipReason = "disabled" | "model_unconfigured"

export interface RevenueShareComputation {
  agentFinalNetCents: number
  brokerageFinalCents: number
  distributions: DistributionRecord[]
  /** Brokerage-funded shares this DEAL's company dollar could not fund — owed
   *  from the company's own books instead (owner ruling 2026-08-28: the cap ends
   *  the brokerage TAKING, not the brokerage PAYING). Never part of the in-deal
   *  distribution set; persisted by step 11 to company_books_obligations (m577). */
  companyObligations: CompanyObligationRecord[]
  skipped: RevenueShareSkipReason | null
}

/**
 * PURE: the money step. CONSERVATION HOLDS BY CONSTRUCTION — every cent pushed
 * into a distribution is deducted from the balance that funds it, so step 11's
 * gross == distributed + finals identity survives:
 *   · source 'agent'     → deducted from the agent's rolling net (the original
 *                          mentor-model behavior).
 *   · source 'brokerage' → deducted from the brokerage's final (the owner's
 *                          "the brokerage pays the share"). BEFORE this model,
 *                          brokerage-funded shares were added as distributions
 *                          with NOTHING deducted, so step 11's validation threw
 *                          on every brokerage-funded closing — the eXp-model
 *                          path was unrunnable as shipped.
 * Rates come off the EDGE (flat cents per closing, else percent of the agent's
 * rolling net — the base the step has always used); the model is the GATE:
 * disabled or unconfigured → no distribution, skip reason returned (the caller
 * records + warns; never silent). An edge outside its effective window pays
 * nothing.
 *
 * OVERDRAFT — the two sides are now DIFFERENT, deliberately (owner ruling
 * 2026-08-28: when a cap is met the brokerage no longer TAKES from the agent;
 * its own obligations to PAY do not end with the deal's company dollar):
 *   · AGENT-funded overdraft still THROWS. The agent's side is the agent's own
 *     money on this deal; a schedule that pays out more than the agent nets is
 *     a contradictory configuration, refused loudly as always.
 *   · BROKERAGE-funded share the deal cannot fund (post-cap the brokerage final
 *     is $0; a straddling deal may leave less than the share) is NOT refused
 *     and NOT overdrafted in-deal: the WHOLE share becomes a COMPANY-BOOKS
 *     OBLIGATION (reason 'post_cap_company_books') in `companyObligations`,
 *     outside the deal's distribution set — the deal's conservation identity
 *     never sees it, and step 11 records it on the company payables ledger
 *     (company_books_obligations, m577) rather than dropping it. The share is
 *     routed whole, never split across the two funding rails: one share, one
 *     ledger row, one payer.
 */
export function computeRevenueShare(input: {
  agentId: string
  agentFinalNetCents: number
  brokerageFinalCents: number
  state: RevenueShareModelState
  relationships: RevenueShareEdge[]
  today?: Date
}): RevenueShareComputation {
  const { state } = input
  const base = {
    agentFinalNetCents: input.agentFinalNetCents,
    brokerageFinalCents: input.brokerageFinalCents,
    distributions: [] as DistributionRecord[],
    companyObligations: [] as CompanyObligationRecord[],
  }
  if (!state.enabled) return { ...base, skipped: "disabled" }
  if (!state.configured || !state.model) return { ...base, skipped: "model_unconfigured" }

  const todayStr = (input.today ?? new Date()).toISOString().slice(0, 10)
  let runningAgentCents = input.agentFinalNetCents
  let runningBrokerageCents = input.brokerageFinalCents
  const distributions: DistributionRecord[] = []
  const companyObligations: CompanyObligationRecord[] = []

  for (const rel of input.relationships) {
    if (rel.is_active === false || !rel.sponsor_agent_id) continue
    if (!withinEffectiveWindow(rel, todayStr)) continue
    // The EDGE's stamped source decides whose money funds this share. Anything
    // outside the vocabulary pays nothing (fail-closed) — the live CHECK only
    // admits 'agent'/'brokerage', so this is unreachable on real rows.
    const source = rel.source_of_funds
    if (source !== "agent" && source !== "brokerage") continue

    const flatCents = Number(rel.revenue_share_flat_cents)
    const pct = Number(rel.revenue_share_percent)
    let shareCents: number
    let calculationType: "percent" | "flat"
    let calculationValue: number
    if (Number.isFinite(flatCents) && flatCents > 0) {
      // Flat: cents per closing, stamped from the model at edge creation.
      shareCents = Math.round(flatCents)
      calculationType = "flat"
      calculationValue = shareCents / 100
    } else if (Number.isFinite(pct) && pct > 0) {
      // Percent of the agent's CURRENT rolling balance (multi-level compounding).
      shareCents = Math.round(runningAgentCents * (pct / 100))
      calculationType = "percent"
      calculationValue = pct
    } else {
      // An edge carrying no terms pays nothing — nothing is invented for it.
      continue
    }
    if (shareCents <= 0) continue

    if (source === "agent") {
      runningAgentCents -= shareCents
      if (runningAgentCents < 0) {
        throw new Error(
          `[revenue-share] Revenue share deductions exceed available commission. ` +
            `Agent ${input.agentId} would have negative balance after level ${rel.depth_level ?? "?"} sponsor.`
        )
      }
    } else {
      // BROKERAGE-funded: the deal's company dollar pays while it lasts. When it
      // cannot cover this share — post-cap it is $0 by the cap ruling; a
      // straddling (hit_cap) deal may leave less than the share — the share is
      // NOT refused (the old overdraft throw failed the producing agent's whole
      // commission over the brokerage's own side-obligation) and NOT overdrafted
      // in-deal: it becomes a company-books obligation, whole, and the in-deal
      // balance is untouched.
      if (shareCents > runningBrokerageCents) {
        companyObligations.push({
          obligation_type: "residual",
          agent_id: rel.sponsor_agent_id,
          calculation_type: calculationType,
          calculation_value: calculationValue,
          calculated_amount: shareCents / 100,
          reason: "post_cap_company_books",
          notes:
            `${rel.relationship_type ?? "sponsor"} revenue share (level ${rel.depth_level ?? 1}, ` +
            `${calculationType}, brokerage-funded) — this deal's company dollar (${runningBrokerageCents}¢ remaining) ` +
            `cannot fund it; owed from company books`,
          ...(rel.id ? { relationship_id: rel.id } : {}),
        })
        continue
      }
      runningBrokerageCents -= shareCents
    }

    distributions.push({
      distribution_type: "residual",
      agent_id: rel.sponsor_agent_id,
      calculation_type: calculationType,
      calculation_value: calculationValue,
      calculated_amount: shareCents / 100, // dollars, like every DistributionRecord
      source_of_funds: source,
      notes: `${rel.relationship_type ?? "sponsor"} revenue share (level ${rel.depth_level ?? 1}, ${calculationType}, ${source}-funded)`,
      ...(rel.id ? { relationship_id: rel.id } : {}),
    })
  }

  return {
    agentFinalNetCents: runningAgentCents,
    brokerageFinalCents: runningBrokerageCents,
    distributions,
    companyObligations,
    skipped: null,
  }
}

// ─── THE ECONOMIC RELATIONSHIP GRAPH → RESIDUAL RULE EVALUATION (wave 107, lane 107A) ────────────
// Owner: "Agent B closes → Economic Event → Commission ledger → Residual relationship lookup → Rule
// evaluation → Residual ledger entry → Finance Manager review. No LLM calculates authoritative money."
// SURVIVORS (audited, none rebuilt): the RULE is the agent_relationships edge (its stamped terms +
// effective window) gated by the brokerage's model (parseRevenueShareModel); the MONEY step is
// computeRevenueShare above; the GRAPH is relationship_edges (lib/kernel/relationship-graph.ts — m698/m715:
// recruited_by, earns_residual, sponsor_of (= "sponsored_by", stored sponsor → recruit), member_of_team,
// referred_by, vendor_for, all with effective_from/effective_to). The graph is a PROJECTION: it corroborates
// a residual, it never prices one (terms live on agent_relationships only — a graph-only edge pays nothing
// and is reported). This file imports no model SDK; test:residual-economics censuses the money path.

/** The residual-ELIGIBLE relations — agent_relationships.relationship_type's live CHECK, one vocabulary (§6). */
export const RESIDUAL_ELIGIBLE_RELATIONSHIPS = ["sponsor", "mentor", "team_lead"] as const

/** relationship_edges types that CORROBORATE a residual edge of each eligible relation (agent endpoints are
 *  USERS ids): recruited_by (recruit → sponsor), earns_residual / sponsor_of (sponsor → recruit), and for a
 *  team lead, member_of_team (recruit → team whose teams.team_lead_id is the beneficiary). */
export const RESIDUAL_CORROBORATING_EDGES: Readonly<Record<(typeof RESIDUAL_ELIGIBLE_RELATIONSHIPS)[number], readonly string[]>> = {
  sponsor: ["recruited_by", "earns_residual", "sponsor_of"],
  mentor: ["earns_residual", "sponsor_of"],
  team_lead: ["earns_residual", "member_of_team"],
}

/** Economic graph relations that are NOT residual-eligible: each has its own rail (referral fee →
 *  distribution_type 'referral' via lib/agents/referral-closer.ts; vendor → vendor_invoices / vendor_payouts).
 *  An edge of these types never mints a residual entry.
 *  @proofSeam scripts/residual-economics-guard.ts asserts these stay in the graph vocabulary and never mint a residual. */
export const NON_RESIDUAL_ECONOMIC_EDGES = ["referred_by", "vendor_for"] as const

export interface ResidualGraphEdge {
  brokerage_id: string | null
  relationship_type: string
  from_entity_type: string
  from_entity_id: string
  to_entity_type: string
  to_entity_id: string
  effective_from?: string | null
  effective_to?: string | null
}

export interface ResidualEntryEvaluation {
  /** Idempotency key: residual:<transaction>:<beneficiary agents.id>:<agent_relationships.id>. */
  key: string
  beneficiaryAgentId: string
  relationshipId: string | null
  relationshipType: string
  depth: number
  cents: number
  /** in_deal → commission_distributions 'residual'; company_books → company_books_obligations (post-cap). */
  rail: "in_deal" | "company_books"
  sourceOfFunds: string
  calculationType: "percent" | "flat"
  calculationValue: number | null
  /** Graph edge types (valid on the evaluation date) that corroborate this residual. */
  corroboratedBy: string[]
}

export interface ResidualEvaluation {
  transactionId: string
  brokerageId: string
  producingAgentId: string
  /** The date every effective window was judged on — the CLOSE date (fallback only when the deal has none). */
  evaluatedOn: string
  evaluatedOnSource: "close_date" | "fallback"
  skipped: RevenueShareSkipReason | null
  entries: ResidualEntryEvaluation[]
  computation: RevenueShareComputation
  /** false = the graph read was refused / absent: corroboration is UNMEASURED (never read as "uncorroborated"). */
  graphMeasured: boolean
  findings: string[]
}

/** PURE — the one spelling of the residual idempotency key (transaction, beneficiary, rule); the proof asserts
 *  its shape through the evaluation's entries. */
function residualEntryKey(transactionId: string, beneficiaryAgentId: string, relationshipId: string | null | undefined): string {
  return `residual:${transactionId}:${beneficiaryAgentId}:${relationshipId ?? "unkeyed"}`
}

/**
 * PURE — DETERMINISTIC residual rule evaluation for ONE closing: no model, no clock (the evaluation date is
 * passed in — the close date), integer cents through computeRevenueShare (the ONE money rule). Edges are
 * tenant-filtered (a foreign row is dropped and reported), narrowed to the producing agent and ordered
 * (depth, id) so two runs over the same rows produce byte-equal output.
 * Product caller: lib/commission/waterfall/09-revenue-share.ts (the money step itself).
 * @proofSeam scripts/residual-economics-guard.ts drives each relationship type, the close-date window, foreign
 * rows and the re-run determinism directly.
 */
export function evaluateResidualRules(input: {
  transactionId: string
  brokerageId: string
  producingAgentId: string
  closeDate: string | null
  /** Used ONLY when the deal has no close date; the caller passes it (no clock in this core). */
  fallbackDate: string
  agentFinalNetCents: number
  brokerageFinalCents: number
  state: RevenueShareModelState
  relationships: ReadonlyArray<RevenueShareEdge & { brokerage_id?: string | null; agent_id?: string | null }>
  graph?: {
    measured: boolean
    edges: readonly ResidualGraphEdge[]
    /** agents.id → users.id (agents.id and users.id are DISJOINT, CLAUDE.md §3). */
    userIdByAgentId: ReadonlyMap<string, string>
    /** teams.id → teams.team_lead_id (users.id). */
    teamLeadUserIdByTeamId?: ReadonlyMap<string, string>
  }
}): ResidualEvaluation {
  const findings: string[] = []
  const evaluatedOn = (input.closeDate ?? input.fallbackDate).slice(0, 10)
  const evaluatedOnSource = input.closeDate ? "close_date" : "fallback"
  if (!input.closeDate) findings.push(`no close date on ${input.transactionId} — effective windows judged on ${evaluatedOn}`)

  const rels = input.relationships
    .filter((r) => {
      if (r.brokerage_id !== undefined && r.brokerage_id !== input.brokerageId) { findings.push(`foreign relationship ${r.id ?? "?"} dropped`); return false }
      if (r.relationship_type && !(RESIDUAL_ELIGIBLE_RELATIONSHIPS as readonly string[]).includes(r.relationship_type)) { findings.push(`relationship ${r.id ?? "?"} type '${r.relationship_type}' is not residual-eligible`); return false }
      return r.agent_id === undefined || r.agent_id === input.producingAgentId
    })
    .slice()
    .sort((a, b) => (a.depth_level ?? 1) - (b.depth_level ?? 1) || String(a.id ?? "").localeCompare(String(b.id ?? "")))

  const computation = computeRevenueShare({
    agentId: input.producingAgentId,
    agentFinalNetCents: input.agentFinalNetCents,
    brokerageFinalCents: input.brokerageFinalCents,
    state: input.state,
    relationships: rels as RevenueShareEdge[],
    today: new Date(`${evaluatedOn}T00:00:00.000Z`),
  })

  const relById = new Map(rels.filter((r) => r.id).map((r) => [String(r.id), r]))
  const graphMeasured = input.graph?.measured === true
  const edges = (input.graph?.edges ?? []).filter((e) => e.brokerage_id === input.brokerageId && withinEffectiveWindow(e, evaluatedOn))
  const producerUser = input.graph?.userIdByAgentId.get(input.producingAgentId) ?? null

  const corroborate = (beneficiaryAgentId: string, relType: string): string[] => {
    if (!graphMeasured || !producerUser) return []
    const beneficiaryUser = input.graph?.userIdByAgentId.get(beneficiaryAgentId) ?? null
    if (!beneficiaryUser) return []
    const allowed = new Set(RESIDUAL_CORROBORATING_EDGES[relType as keyof typeof RESIDUAL_CORROBORATING_EDGES] ?? [])
    const hits = new Set<string>()
    for (const e of edges) {
      if (!allowed.has(e.relationship_type)) continue
      if (e.relationship_type === "recruited_by" && e.from_entity_id === producerUser && e.to_entity_id === beneficiaryUser) hits.add(e.relationship_type)
      if ((e.relationship_type === "earns_residual" || e.relationship_type === "sponsor_of") && e.from_entity_id === beneficiaryUser && e.to_entity_id === producerUser) hits.add(e.relationship_type)
      if (e.relationship_type === "member_of_team" && e.from_entity_id === producerUser && e.to_entity_type === "team" && input.graph?.teamLeadUserIdByTeamId?.get(e.to_entity_id) === beneficiaryUser) hits.add(e.relationship_type)
    }
    return Array.from(hits).sort()
  }

  const entries: ResidualEntryEvaluation[] = []
  const push = (rail: ResidualEntryEvaluation["rail"], d: { agent_id?: string; relationship_id?: string; calculated_amount: number; calculation_type: "percent" | "flat"; calculation_value?: number }, sourceOfFunds: string) => {
    if (!d.agent_id) return
    const rel = d.relationship_id ? relById.get(d.relationship_id) : undefined
    const relationshipType = rel?.relationship_type ?? "sponsor"
    const corroboratedBy = corroborate(d.agent_id, relationshipType)
    if (graphMeasured && corroboratedBy.length === 0) findings.push(`residual to ${d.agent_id} (${relationshipType}) has no corroborating graph edge on ${evaluatedOn}`)
    entries.push({
      key: residualEntryKey(input.transactionId, d.agent_id, d.relationship_id),
      beneficiaryAgentId: d.agent_id,
      relationshipId: d.relationship_id ?? null,
      relationshipType,
      depth: rel?.depth_level ?? 1,
      cents: Math.round(d.calculated_amount * 100),
      rail,
      sourceOfFunds,
      calculationType: d.calculation_type,
      calculationValue: d.calculation_value ?? null,
      corroboratedBy,
    })
  }
  for (const d of computation.distributions) push("in_deal", d, d.source_of_funds)
  for (const o of computation.companyObligations) push("company_books", o, "brokerage")

  // A graph residual edge with no paying rule: reported, never paid (terms live on agent_relationships).
  if (graphMeasured && producerUser && !computation.skipped) {
    const paidUsers = new Set(entries.map((x) => input.graph?.userIdByAgentId.get(x.beneficiaryAgentId)).filter(Boolean) as string[])
    for (const e of edges) {
      if (e.relationship_type === "earns_residual" && e.to_entity_id === producerUser && !paidUsers.has(e.from_entity_id)) {
        findings.push(`earns_residual edge from user ${e.from_entity_id} has no agent_relationships terms in force on ${evaluatedOn} — pays nothing`)
      }
    }
  }

  return {
    transactionId: input.transactionId,
    brokerageId: input.brokerageId,
    producingAgentId: input.producingAgentId,
    evaluatedOn,
    evaluatedOnSource,
    skipped: computation.skipped,
    entries,
    computation,
    graphMeasured,
    findings,
  }
}
