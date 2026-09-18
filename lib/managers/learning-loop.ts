// lib/managers/learning-loop.ts
//
// THE MANAGER LEARNING LOOP — the step that turns a GRADED team into a SELF-IMPROVING one.
//
// Outcomes were already measured (strategy_outcomes, marketing weekly, rubric grades, and now
// lost-deal categories) but nothing fed them back into the managers' future behavior. This closes
// that loop: it reads a brokerage's recent OUTCOMES, derives LEARNED ADJUSTMENTS, and writes them
// to brokerage_settings.settings.learned_adjustments — the shared store the managers read at
// decision time. The first wired adjustment is financing_risk_sensitivity: when a brokerage keeps
// LOSING deals on financing, the Deal-Save Huddle tightens its lender/earnest-money threshold so
// the NEXT deal gets earlier financing intervention (huddle convenes + the lender is notified
// sooner). Past losses → future behavior. Multi-manager: the same signal informs the Deal
// Coordinator's huddle AND the Shopping Agent's offer posture.
//
// HONEST: no fabrication. Below a minimum sample the loop derives NOTHING (returns []), so a brand
// new brokerage is never "tuned" on noise. PURE derivation is unit-tested; the runner does the I/O.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export type LearnedManager = "deal_coordinator" | "shopping_agent"

export interface LearnedAdjustment {
  manager: LearnedManager
  key: string
  value: string
  rationale: string
  sample: number
}

export interface OutcomeStats {
  lostByCategory: Record<string, number>
  lostTotal: number
  strategy: { total: number; accepted: number; rejected: number; countered: number; avgDeviation: number }
}

/** Minimum sample before the loop will tune anything — below this it stays silent (honest). */
export const MIN_LOST_SAMPLE = 4
const MIN_STRATEGY_SAMPLE = 5
/** A brokerage losing this share of its deals to financing earns a high financing-risk posture. */
export const FINANCING_LOSS_SHARE_HIGH = 0.3
/** Offer rejections above this share (with aggressive deviation) earn a conservative posture. */
const OFFER_REJECT_SHARE_HIGH = 0.4

/**
 * PURE: derive the learned adjustments from a brokerage's recent outcome stats. Returns [] when
 * there isn't enough signal to learn from (no fabrication on a small sample).
 */
export function deriveLearnedAdjustments(stats: OutcomeStats): LearnedAdjustment[] {
  const out: LearnedAdjustment[] = []

  // ── Financing-risk sensitivity (Deal Coordinator + the huddle) ──────────────
  if (stats.lostTotal >= MIN_LOST_SAMPLE) {
    const financingLost = stats.lostByCategory["financing"] ?? 0
    const share = financingLost / stats.lostTotal
    if (share >= FINANCING_LOSS_SHARE_HIGH) {
      out.push({
        manager: "deal_coordinator",
        key: "financing_risk_sensitivity",
        value: "high",
        rationale: `${Math.round(share * 100)}% of the last ${stats.lostTotal} lost deals died on financing — tighten the huddle's lender/earnest-money threshold so the next deal gets earlier intervention.`,
        sample: stats.lostTotal,
      })
    }
  }

  // ── Offer posture (Shopping Agent) ──────────────────────────────────────────
  const s = stats.strategy
  if (s.total >= MIN_STRATEGY_SAMPLE) {
    const rejectShare = s.rejected / s.total
    if (rejectShare >= OFFER_REJECT_SHARE_HIGH && s.avgDeviation > 0.03) {
      out.push({
        manager: "shopping_agent",
        key: "offer_posture",
        value: "conservative",
        rationale: `${Math.round(rejectShare * 100)}% of the last ${s.total} offers were rejected at an aggressive avg deviation — recommend closer to ask next time.`,
        sample: s.total,
      })
    } else if (s.accepted / s.total >= 0.6) {
      out.push({
        manager: "shopping_agent",
        key: "offer_posture",
        value: "data_supported",
        rationale: `${Math.round((s.accepted / s.total) * 100)}% of the last ${s.total} offers were accepted — the current strategy is landing.`,
        sample: s.total,
      })
    }
  }

  return out
}

/** Window the learning loop looks back over. */
export const LEARNING_WINDOW_DAYS = 180

interface LearnedEntry { manager: LearnedManager; value: string; rationale: string; sample: number; computed_at: string }

/**
 * Read recent outcomes for a brokerage, derive learned adjustments, and persist them to
 * brokerage_settings.settings.learned_adjustments (merge). Idempotent (overwrites the learned
 * block each run); best-effort; never throws. Returns the adjustments + whether they were written.
 */
export async function runManagerLearning(
  brokerageId: string,
  opts: { now?: Date } = {},
  client?: Svc,
): Promise<{ adjustments: LearnedAdjustment[]; written: boolean }> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - LEARNING_WINDOW_DAYS * 86_400_000).toISOString()

  // Lost deals by category.
  const { data: lost } = await supabase
    .from("transactions")
    .select("lost_category")
    .eq("brokerage_id", brokerageId)
    .not("lost_at", "is", null)
    .gte("lost_at", since)
    .limit(1000)
  const lostByCategory: Record<string, number> = {}
  for (const r of (lost ?? []) as Array<{ lost_category: string | null }>) {
    const c = (r.lost_category ?? "unknown").toLowerCase()
    lostByCategory[c] = (lostByCategory[c] ?? 0) + 1
  }

  // Strategy outcomes (offer recommendations).
  const { data: outcomes } = await supabase
    .from("strategy_outcomes")
    .select("outcome, deviation_from_recommendation")
    .eq("brokerage_id", brokerageId)
    .gte("created_at", since)
    .limit(1000)
  const so = (outcomes ?? []) as Array<{ outcome: string | null; deviation_from_recommendation: number | null }>
  const accepted = so.filter((o) => o.outcome === "accepted").length
  const rejected = so.filter((o) => o.outcome === "rejected").length
  const countered = so.filter((o) => o.outcome === "countered").length
  const avgDeviation = so.length > 0 ? so.reduce((a, o) => a + Math.abs(o.deviation_from_recommendation ?? 0), 0) / so.length : 0

  const stats: OutcomeStats = {
    lostByCategory,
    lostTotal: (lost ?? []).length,
    strategy: { total: so.length, accepted, rejected, countered, avgDeviation },
  }
  const adjustments = deriveLearnedAdjustments(stats)

  // Persist — merge into brokerage_settings.settings.learned_adjustments.
  const learned: Record<string, LearnedEntry> = {}
  for (const a of adjustments) learned[a.key] = { manager: a.manager, value: a.value, rationale: a.rationale, sample: a.sample, computed_at: now.toISOString() }

  const { data: existing } = await supabase.from("brokerage_settings").select("id, settings").eq("brokerage_id", brokerageId).maybeSingle()
  const prevSettings = ((existing as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>
  const nextSettings = { ...prevSettings, learned_adjustments: learned, learned_adjustments_computed_at: now.toISOString() }

  let written = false
  if (existing) {
    const { error } = await supabase.from("brokerage_settings").update({ settings: nextSettings, updated_at: now.toISOString() }).eq("brokerage_id", brokerageId)
    written = !error
  } else {
    const { error } = await supabase.from("brokerage_settings").insert({ brokerage_id: brokerageId, settings: nextSettings })
    written = !error
  }
  return { adjustments, written }
}

/**
 * Read one learned adjustment for a brokerage (the value, or null). The HUMAN OFF-SWITCH is
 * enforced HERE, at the single read chokepoint every consumer (the huddle's financing
 * sensitivity, the Shopping Agent's offer posture) goes through: a broker veto
 * (settings.learned_vetoes[key]=true) makes this return null, so vetoing one adjustment
 * instantly disables it everywhere. Best-effort.
 */
export async function getLearnedAdjustment(brokerageId: string, key: string, client?: Svc): Promise<string | null> {
  const supabase = client ?? createServiceClient()
  const { data } = await supabase.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  const settings = ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>
  const vetoes = (settings.learned_vetoes ?? {}) as Record<string, boolean>
  if (vetoes[key] === true) return null // broker vetoed this learned behavior
  const learned = (settings.learned_adjustments ?? {}) as Record<string, { value?: string } | undefined>
  return learned[key]?.value ?? null
}

export interface LearnedAdjustmentView {
  key: string
  manager: string
  value: string
  rationale: string
  sample: number
  computed_at: string | null
  vetoed: boolean
}

/** List every learned adjustment for a brokerage (with its veto state) — the human-oversight read. */
export async function listLearnedAdjustments(brokerageId: string, client?: Svc): Promise<LearnedAdjustmentView[]> {
  const supabase = client ?? createServiceClient()
  const { data } = await supabase.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  const settings = ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>
  const learned = (settings.learned_adjustments ?? {}) as Record<string, LearnedEntry | undefined>
  const vetoes = (settings.learned_vetoes ?? {}) as Record<string, boolean>
  return Object.entries(learned).map(([key, e]) => ({
    key,
    manager: e?.manager ?? "—",
    value: e?.value ?? "",
    rationale: e?.rationale ?? "",
    sample: e?.sample ?? 0,
    computed_at: e?.computed_at ?? null,
    vetoed: vetoes[key] === true,
  }))
}

/** Set or clear a broker veto on a learned adjustment. Best-effort; returns the new veto state. */
export async function setLearnedAdjustmentVeto(brokerageId: string, key: string, vetoed: boolean, client?: Svc): Promise<{ ok: boolean; vetoed: boolean }> {
  const supabase = client ?? createServiceClient()
  const { data } = await supabase.from("brokerage_settings").select("id, settings").eq("brokerage_id", brokerageId).maybeSingle()
  const settings = ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>
  const vetoes = { ...((settings.learned_vetoes ?? {}) as Record<string, boolean>) }
  if (vetoed) vetoes[key] = true
  else delete vetoes[key]
  const nextSettings = { ...settings, learned_vetoes: vetoes }
  if (data) {
    const { error } = await supabase.from("brokerage_settings").update({ settings: nextSettings, updated_at: new Date().toISOString() }).eq("brokerage_id", brokerageId)
    return { ok: !error, vetoed }
  }
  const { error } = await supabase.from("brokerage_settings").insert({ brokerage_id: brokerageId, settings: nextSettings })
  return { ok: !error, vetoed }
}
