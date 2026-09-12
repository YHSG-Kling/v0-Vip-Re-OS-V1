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
 * Internal to the module: computeRevenueShare applies it, and the guard proves
 * the behavior through computeRevenueShare's window cases.
 */
function withinEffectiveWindow(edge: Pick<RevenueShareEdge, "effective_from" | "effective_to">, todayStr: string): boolean {
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
