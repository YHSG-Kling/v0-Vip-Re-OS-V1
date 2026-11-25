// lib/recruiting/recruiting-roi-compute.ts
//
// RECRUITING ROI WRITER (recruiting_manager) — recruiting_roi was READ by the ROI dashboard, the agent
// scorecard, and the brokerage P&L, but NOTHING wrote it in production (only simulators inserted rows),
// so the headline ROI / net / breakeven KPIs read EMPTY in prod. This computes a REAL row per recruited
// agent from the data we actually have — recruiting_costs (what we spent) + recruiting_analytics (the
// brokerage's net FROM that agent) — and is HONEST about what the data can't yet support (breakeven
// month / forward LTV need a monthly cohort + retention model we don't have, so they stay null rather
// than fabricated). Pure compute is unit-tested; the writer upserts one row per recruited agent.

export interface RecruitingCostRow { amount: number | null }
export interface RecruitingAnalyticsRow {
  brokerage_net_from_agent: number | null
  gross_commission_generated: number | null
  year_number: number | null
}

export interface RecruitingRoi {
  total_recruiting_cost: number
  lifetime_brokerage_net: number
  /** (net − cost) / cost × 100, rounded. Null when cost is 0 (can't divide — honest, not "0%"). */
  roi_pct: number | null
  /** Requires a monthly cost/production cohort we don't track yet → honest null (never fabricated). */
  breakeven_month: number | null
  /** Forward LTV needs a retention/run-rate model we don't have → honest null. */
  ltv_estimate: number | null
}

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/**
 * PURE: compute a recruited agent's ROI from real cost + production rows. Uses the brokerage's NET from
 * the agent (not gross) — the true return on the recruiting spend. roi_pct is null when there's no cost
 * to divide by; breakeven_month + ltv_estimate stay null until the data supports them (no fabrication).
 */
export function computeRecruitingRoi(costs: RecruitingCostRow[], analytics: RecruitingAnalyticsRow[]): RecruitingRoi {
  const total_recruiting_cost = costs.reduce((s, c) => s + n(c.amount), 0)
  const lifetime_brokerage_net = analytics.reduce((s, a) => s + n(a.brokerage_net_from_agent), 0)
  const roi_pct = total_recruiting_cost > 0
    ? Math.round(((lifetime_brokerage_net - total_recruiting_cost) / total_recruiting_cost) * 100)
    : null
  return {
    total_recruiting_cost: Math.round(total_recruiting_cost * 100) / 100,
    lifetime_brokerage_net: Math.round(lifetime_brokerage_net * 100) / 100,
    roi_pct,
    breakeven_month: null,
    ltv_estimate: null,
  }
}

/**
 * PURE: the brokerage's NET from a deal's gross commission, given the agent's split (the % the AGENT
 * keeps). Brokerage net = gross × (1 − split/100). Returns null when the split is unknown — honest, so
 * the analytics row records gross-only rather than a guessed net.
 */
export function brokerageNetFromSplit(grossCommission: number | null, agentSplitPercent: number | null): number | null {
  const g = n(grossCommission)
  if (g <= 0) return 0
  if (agentSplitPercent == null || !Number.isFinite(agentSplitPercent)) return null
  const split = Math.min(100, Math.max(0, agentSplitPercent))
  return Math.round(g * (1 - split / 100) * 100) / 100
}

// ─── WAVE 156 (lane 156K) — THE RECRUITING FUNNEL, FROM PERSISTED EVENTS ONLY ────────────────────────────────────────────
//
// verified prospect → contacted (a recruiting outreach a HUMAN approved, or the recorded stage) → conversation → offer → joined →
// seat provisioned → trained (an onboarding certification on the agents row) → retained (the seat is still active) → producing
// (a recruiting_analytics year with a transaction). Each count comes from a stored row: recruits (stage, provisioned), the action
// ledger's recorded stage moves (app/api/recruiting/advance-stage, action recruiting.recruit.advance_stage), agent_client_messages,
// agents, agent_certifications, recruiting_analytics. A stage whose source could not be read is null — never 0. Nothing here
// reads, infers or scores a personal trait: the funnel counts recorded EVENTS per recruit, and no stage decides who may proceed.
// @proofSeam PURE — scripts/wave156-k-guard.ts

export const RECRUIT_FUNNEL_STAGES = [
  { key: "sourced", label: "Verified prospects" },
  { key: "contacted", label: "Contacted (human-approved outreach)" },
  { key: "conversation", label: "Conversation / interview" },
  { key: "offer", label: "Offer extended" },
  { key: "joined", label: "Joined" },
  { key: "seat_provisioned", label: "Seat provisioned" },
  { key: "trained", label: "Certified in onboarding" },
  { key: "retained", label: "Still active" },
  { key: "producing", label: "Producing (a recorded transaction)" },
] as const
export type RecruitFunnelStageKey = (typeof RECRUIT_FUNNEL_STAGES)[number]["key"]

/** The pipeline order of recruits.status (stale-recruit-policy RECRUIT_STATUSES minus the terminal "declined"). */
const STAGE_RANK: Record<string, number> = { prospect: 0, contacted: 1, interviewing: 2, offer_extended: 3, joined: 4 }

export interface RecruitFunnelFacts {
  recruits: Array<{ id: string; status: string | null; provisioned: boolean | null; provisioned_user_id: string | null }>
  /** recruit id → every stage a recorded, executed stage move took it to; null = the ledger could not be read. */
  recordedMoves: Record<string, string[]> | null
  /** recruit ids with a recruiting outreach a human approved (approved / sent); null = unreadable. */
  approvedOutreach: string[] | null
  /** provisioned users.id → the seat's facts; null = unreadable. Each inner fact may itself be null (its own read refused). */
  seats: Record<string, { active: boolean | null; certified: boolean | null; producing: boolean | null }> | null
  /** ROUND 2: stages this SEAT may not read (decided by the caller from the role rules) — reported as not_permitted, never 0
   *  and never "unknown". */
  notPermitted?: readonly RecruitFunnelStageKey[]
}

/** ROUND 2: three states a figure can be in. "ok" carries a real count (0 included); "unknown" = its source could not be read;
 *  "not_permitted" = this seat may not read it. */
export type RecruitFunnelFigureState = "ok" | "unknown" | "not_permitted"

export function computeRecruitingFunnel(f: RecruitFunnelFacts): { stages: Array<{ key: RecruitFunnelStageKey; label: string; count: number | null; state: RecruitFunnelFigureState }>; declined: number } {
  const reached = (r: RecruitFunnelFacts["recruits"][number], rank: number): boolean => {
    if (r.provisioned) return true
    const cur = STAGE_RANK[String(r.status ?? "")]
    if (cur !== undefined && cur >= rank) return true
    return (f.recordedMoves?.[r.id] ?? []).some((s) => (STAGE_RANK[s] ?? -1) >= rank)
  }
  const R = f.recruits
  const outreach = new Set(f.approvedOutreach ?? [])
  const seatIds = R.filter((r) => r.provisioned && r.provisioned_user_id).map((r) => r.provisioned_user_id as string)
  const seatCount = (k: "active" | "certified" | "producing"): number | null => {
    if (!f.seats) return null
    let n = 0
    for (const id of seatIds) { const s = f.seats[id]; if (!s || s[k] === null) return null; if (s[k]) n++ }
    return n
  }
  const byRank = (rank: number): number => R.filter((r) => reached(r, rank)).length
  // A stage that leans on the ledger reads as unknown when the ledger could not be read (a declined recruit's history lives there).
  const counts: Record<RecruitFunnelStageKey, number | null> = {
    sourced: R.length,
    contacted: f.approvedOutreach === null || f.recordedMoves === null ? null : R.filter((r) => outreach.has(r.id) || reached(r, 1)).length,
    conversation: f.recordedMoves === null ? null : byRank(2),
    offer: f.recordedMoves === null ? null : byRank(3),
    joined: R.filter((r) => r.provisioned || r.status === "joined").length,
    seat_provisioned: seatIds.length,
    trained: seatCount("certified"),
    retained: seatCount("active"),
    producing: seatCount("producing"),
  }
  return {
    stages: RECRUIT_FUNNEL_STAGES.map((s) => {
      if (f.notPermitted?.includes(s.key)) return { key: s.key, label: s.label, count: null, state: "not_permitted" as const }
      const count = counts[s.key]
      return { key: s.key, label: s.label, count, state: count === null ? "unknown" as const : "ok" as const }
    }),
    declined: R.filter((r) => r.status === "declined").length,
  }
}
