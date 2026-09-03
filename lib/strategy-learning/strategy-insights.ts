// lib/strategy-learning/strategy-insights.ts
//
// STRATEGY-LEARNING READ SIDE — the payoff of the outcome-closing loop. The loop
// accumulates strategy_outcomes (what each offer recommendation actually did:
// accepted/rejected/countered, at what final price, how far from the recommended
// number). This reads that history back into MARKET INTELLIGENCE — win rate, how
// far winning offers landed from the recommendation, and which strategy types are
// converting — and emits a compact prompt context the offer recommender injects so
// the NEXT recommendation is grounded in real outcomes, not just priors.
//
// Owned by the Shopping Agent (buyer-side offer strategy). Pure aggregation over
// the tables the audit made trustworthy — no model narration in the numbers.

import { createServiceClient } from "@/lib/supabase/service"

export interface StrategyTypeStat {
  type: string
  total: number
  accepted: number
  /** accepted / (accepted + rejected); null when no decisive outcomes yet. */
  winRate: number | null
  /** avg |final − recommended| for ACCEPTED offers; null when none. */
  avgAcceptedDeviation: number | null
}

export interface StrategyInsights {
  windowDays: number
  sampleSize: number
  /** accepted / (accepted + rejected) across all strategy types. */
  winRate: number | null
  /** avg deviation of accepted offers from the recommended price. */
  avgAcceptedDeviation: number | null
  /** count by terminal outcome. */
  outcomeCounts: { accepted: number; rejected: number; countered: number; withdrawn: number }
  byStrategyType: StrategyTypeStat[]
  /** Compact NL summary the recommender injects into its prompt. Always safe to
   *  embed (no PII) and degrades to a "no history yet" line on an empty sample. */
  promptContext: string
  /**
   * WHAT THE HUMANS WROTE ON THESE OUTCOMES — strategy_outcomes.notes.
   *
   * The closer stamps a note on every outcome it files
   * (lib/strategy-learning/close-strategy-loop.ts:146 and the buyer-offer path), and
   * nothing ever read the column: the numbers said an offer was rejected, and the one
   * sentence explaining WHY was write-only. Only genuinely human notes survive here —
   * the closer's own `Auto-closed on offer <outcome>` template carries no information
   * the outcome column does not already hold, so it is filtered out rather than padding
   * the list.
   *
   * DELIBERATELY NOT IN `promptContext`. This is free text an agent typed about a live
   * deal; it can name a client, an address or a counterparty, and promptContext's whole
   * contract (above) is that it is safe to embed in a model prompt. These reach the
   * human strategy board only.
   */
  recentNotes: string[]
  /** How many outcomes in the window carried ANY note — the denominator for the list
   *  above, so a board showing two notes does not imply only two outcomes were annotated. */
  notesRecorded: number
}

interface OutcomeRow {
  outcome: string
  deviation_from_recommendation: number | null
  recommendation_id: string | null
  /** Optional on the type: rows read before this column was selected, and the pure
   *  simulator's fixtures, simply have no note. */
  notes?: string | null
}

/** The closer's own template (close-strategy-loop.ts:146). Not a human note. */
const AUTO_CLOSE_NOTE_PREFIX = "Auto-closed on offer"

function pct(n: number): string { return `${Math.round(n * 100)}%` }
function usd(n: number): string { return `$${Math.round(n).toLocaleString()}` }

/** Pure: fold raw outcome+strategy-type rows into the insights contract. */
export function computeStrategyInsights(
  rows: Array<OutcomeRow & { strategyType: string }>,
  windowDays: number,
): StrategyInsights {
  const outcomeCounts = { accepted: 0, rejected: 0, countered: 0, withdrawn: 0 }
  const acceptedDevs: number[] = []
  const byType = new Map<string, { total: number; accepted: number; rejected: number; devs: number[] }>()

  for (const r of rows) {
    if (r.outcome in outcomeCounts) (outcomeCounts as Record<string, number>)[r.outcome] += 1
    const t = byType.get(r.strategyType) ?? { total: 0, accepted: 0, rejected: 0, devs: [] }
    t.total += 1
    if (r.outcome === "accepted") {
      t.accepted += 1
      if (r.deviation_from_recommendation != null) { acceptedDevs.push(r.deviation_from_recommendation); t.devs.push(r.deviation_from_recommendation) }
    } else if (r.outcome === "rejected") {
      t.rejected += 1
    }
    byType.set(r.strategyType, t)
  }

  const decisive = outcomeCounts.accepted + outcomeCounts.rejected
  const winRate = decisive > 0 ? outcomeCounts.accepted / decisive : null
  const avgAcceptedDeviation = acceptedDevs.length > 0 ? acceptedDevs.reduce((a, b) => a + b, 0) / acceptedDevs.length : null

  const byStrategyType: StrategyTypeStat[] = Array.from(byType.entries())
    .map(([type, s]) => ({
      type,
      total: s.total,
      accepted: s.accepted,
      winRate: (s.accepted + s.rejected) > 0 ? s.accepted / (s.accepted + s.rejected) : null,
      avgAcceptedDeviation: s.devs.length > 0 ? s.devs.reduce((a, b) => a + b, 0) / s.devs.length : null,
    }))
    .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1) || b.total - a.total)

  // Compact, recommender-ready context.
  let promptContext: string
  if (rows.length === 0) {
    promptContext = "No prior offer-strategy outcomes recorded yet — use standard priors."
  } else {
    const parts: string[] = [`Based on ${rows.length} prior offer outcome${rows.length === 1 ? "" : "s"} in the last ${windowDays} days:`]
    if (winRate != null) parts.push(`overall acceptance rate ${pct(winRate)}`)
    if (avgAcceptedDeviation != null) parts.push(`accepted offers landed ~${usd(avgAcceptedDeviation)} from the recommended price on average`)
    const best = byStrategyType.find((s) => s.winRate != null)
    if (best) parts.push(`'${best.type}' strategy is converting best (${pct(best.winRate as number)} on ${best.total})`)
    promptContext = parts.join("; ") + "."
  }

  // Human notes only, newest-first order preserved from the caller, deduped, bounded.
  const seenNotes = new Set<string>()
  const recentNotes: string[] = []
  let notesRecorded = 0
  for (const r of rows) {
    const raw = typeof r.notes === "string" ? r.notes.trim() : ""
    if (!raw) continue
    notesRecorded += 1
    if (raw.startsWith(AUTO_CLOSE_NOTE_PREFIX)) continue
    const trimmed = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw
    if (seenNotes.has(trimmed)) continue
    seenNotes.add(trimmed)
    if (recentNotes.length < 5) recentNotes.push(trimmed)
  }

  return {
    windowDays,
    sampleSize: rows.length,
    winRate,
    avgAcceptedDeviation,
    outcomeCounts,
    byStrategyType,
    promptContext,
    recentNotes,
    notesRecorded,
  }
}

export interface StrategyInsightsParams {
  brokerageId: string
  windowDays?: number
}

/**
 * Read strategy_outcomes (joined to their recommendation's strategy_type) into
 * market intelligence for a brokerage. Best-effort: returns an empty-but-valid
 * insights object on no data, so the recommender can always inject promptContext.
 */
export async function generateStrategyInsights(
  params: StrategyInsightsParams,
  client?: ReturnType<typeof createServiceClient>,
): Promise<StrategyInsights> {
  const supabase = client ?? createServiceClient()
  const windowDays = params.windowDays ?? 90
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()

  const { data: outcomes } = await supabase
    .from("strategy_outcomes")
    // `notes` — the human sentence on each outcome, written by every closer and read by
    // nothing until w26. Ordered newest-first so `recentNotes` is genuinely recent.
    .select("outcome, deviation_from_recommendation, recommendation_id, notes")
    .eq("brokerage_id", params.brokerageId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(2000)

  const rows = (outcomes ?? []) as OutcomeRow[]
  if (rows.length === 0) return computeStrategyInsights([], windowDays)

  // Resolve each recommendation's strategy_type (ai_analysis.strategy_type), batched.
  const recIds = Array.from(new Set(rows.map((r) => r.recommendation_id).filter(Boolean))) as string[]
  const typeById = new Map<string, string>()
  if (recIds.length > 0) {
    const { data: recs } = await supabase
      .from("strategy_recommendations")
      .select("id, ai_analysis")
      .in("id", recIds)
    for (const rec of (recs ?? []) as Array<{ id: string; ai_analysis: { strategy_type?: string } | null }>) {
      typeById.set(rec.id, rec.ai_analysis?.strategy_type ?? "standard")
    }
  }

  const enriched = rows.map((r) => ({ ...r, strategyType: (r.recommendation_id && typeById.get(r.recommendation_id)) || "standard" }))
  return computeStrategyInsights(enriched, windowDays)
}
