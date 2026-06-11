// lib/kernel/commission-forecaster.ts
//
// COMMISSION & CAP FORECASTER — a live, forward-looking projection for each agent:
// "you're $X from your commission cap" and "you're on pace for $Y GCI this year",
// computed from the REAL pipeline (closed YTD + in-progress deals weighted by
// win_probability / stage), with the team recommending WHICH 1-2 near-close deals to
// push to hit the cap/goal. Delivered as a gated, agent-facing summary (audience
// 'agent', via proposeClientMessage, agentKind 'deal_coordinator'); an OPTIONAL audio
// brief in the agent's CONFIGURED assistant voice is attached only when a voice is set
// AND synthesis is available (reusing resolveAssistantVoiceId + whisperTierCapability) —
// text otherwise. Never silently nothing.
//
// NO FABRICATION: every number comes from real rows. The commission cap is an OPTIONAL
// input (agents.cap_amount → agent_cap_tracking.cap_amount fallback); when unconfigured
// the forecast reports GCI/pace only and says the cap is unconfigured rather than
// inventing one. The GCI goal is the agent's agent_goals row (goal_type
// 'gross_commission', current year) when present.
//
// The math is PURE + analytical (forecastGci / capDistance / dealsToPush); the live
// runner is a thin orchestration around it. NOT server-only (simulator-driven).

import { createServiceClient } from "@/lib/supabase/service"
import {
  resolveAssistantVoiceId,
  whisperTierCapability,
  type WhisperSynthesizer,
} from "@/lib/intelligence/appointment-whisper"
import { mapUserTypeToTier } from "@/lib/kernel/0.1-feature-access"

type Svc = ReturnType<typeof createServiceClient>

// ── Pure domain types ────────────────────────────────────────────────────────

/** An in-progress (not yet closed/lost) deal contributing to the weighted pipeline. */
export interface PipelineDeal {
  id: string
  /** Display label for the deal (deal_name / address). */
  name: string
  /** This agent's expected commission on the deal (estimated_commission, falling back
   *  to commission_amount, then purchase_price × commission_percentage). Never null. */
  estimatedCommission: number
  /** 0..1 — the deal's win probability. Derived from win_probability (0..1 or 0..100)
   *  with a STAGE-based fallback when the column is null. */
  winProbability: number
  /** Pipeline stage (UNDER_CONTRACT … CLOSING_PREP), used for tie-breaking + leverage. */
  stage: string | null
  /** Expected close date (estimated_close_date / close_date) when known. */
  expectedCloseDate: string | null
}

export interface GciForecast {
  /** GCI already booked from deals CLOSED year-to-date. */
  closedYtd: number
  /** Probability-weighted GCI still in the pipeline (Σ commission × winProbability). */
  weightedPipeline: number
  /** Projected ANNUAL GCI = closedYtd + weightedPipeline, annualized to year-end pace. */
  projectedAnnualGci: number
  /** Year-to-date pace: closedYtd annualized by the fraction of the year elapsed. */
  paceAnnualizedGci: number
  /** The agent's GCI goal when set (agent_goals gross_commission), else null. */
  goal: number | null
  /** Projected GCI − goal (positive = ahead of goal); null when no goal set. */
  projectedVsGoal: number | null
  /** Fraction of the year elapsed [0..1] used for the pace annualization. */
  yearElapsed: number
}

export interface CapStatus {
  /** The configured cap when present, else null (cap unconfigured). */
  cap: number | null
  /** GCI booked YTD applied against the cap. */
  gciYtd: number
  /** cap − gciYtd, floored at 0; null when no cap configured. */
  distanceToCap: number | null
  /** True once gciYtd ≥ cap (post-cap; agent keeps more of every dollar). */
  isCapped: boolean
  /** 0..1 cap progress; null when no cap configured. */
  progress: number | null
}

// ── Stage leverage (pure) ─────────────────────────────────────────────────────

/** Near-close ordering — the further along the pipeline, the higher the leverage of a
 *  "push" (these deals can actually close THIS quarter). Used for dealsToPush ranking. */
const STAGE_LEVERAGE: Record<string, number> = {
  CLOSING_PREP: 5,
  FINANCING_PENDING: 4,
  APPRAISAL: 3,
  INSPECTION: 2,
  UNDER_CONTRACT: 1,
}

/** Default win probability by stage when win_probability is null — conservative, never
 *  fabricated optimism: an under-contract deal that's already at closing-prep is likelier
 *  than one fresh under contract. Returns 0..1. */
export function stageWinProbability(stage: string | null): number {
  switch (stage) {
    case "CLOSING_PREP": return 0.9
    case "FINANCING_PENDING": return 0.75
    case "APPRAISAL": return 0.7
    case "INSPECTION": return 0.6
    case "UNDER_CONTRACT": return 0.5
    default: return 0.4
  }
}

/** Normalize a raw win_probability column (which may be stored as 0..1 or 0..100) to a
 *  0..1 fraction; falls back to the stage default when null/invalid. PURE. */
export function normalizeWinProbability(raw: number | null | undefined, stage: string | null): number {
  if (raw == null || !Number.isFinite(raw)) return stageWinProbability(stage)
  let p = Number(raw)
  if (p > 1) p = p / 100
  if (p < 0) p = 0
  if (p > 1) p = 1
  return p
}

// ── forecastGci (pure) ────────────────────────────────────────────────────────

/**
 * PURE projection. Given GCI already closed YTD, the in-progress pipeline, and `now`:
 *  · weightedPipeline = Σ deal.estimatedCommission × deal.winProbability
 *  · projectedAnnualGci = closedYtd + weightedPipeline (what the year lands at if the
 *    weighted pipeline closes) — forward-looking, NOT annualized speculation
 *  · paceAnnualizedGci = closedYtd ÷ yearElapsed (pure run-rate, "if you keep this pace")
 * `goal` is optional; projectedVsGoal is null when no goal is supplied.
 */
export function forecastGci(
  closedYtd: number,
  pipeline: PipelineDeal[],
  now: Date,
  goal: number | null = null,
): GciForecast {
  const closed = Math.max(0, Number(closedYtd) || 0)
  const weightedPipeline = pipeline.reduce(
    (s, d) => s + Math.max(0, Number(d.estimatedCommission) || 0) * normalizeWinProbability(d.winProbability, d.stage),
    0,
  )
  const projectedAnnualGci = closed + weightedPipeline

  // Fraction of the calendar year elapsed (clamped to avoid divide-by-zero in early Jan).
  const year = now.getUTCFullYear()
  const yearStart = Date.UTC(year, 0, 1)
  const yearEnd = Date.UTC(year + 1, 0, 1)
  const elapsedRaw = (now.getTime() - yearStart) / (yearEnd - yearStart)
  const yearElapsed = Math.min(1, Math.max(1 / 365, elapsedRaw))
  const paceAnnualizedGci = closed / yearElapsed

  const projectedVsGoal = goal != null ? projectedAnnualGci - goal : null

  return {
    closedYtd: closed,
    weightedPipeline: Math.round(weightedPipeline),
    projectedAnnualGci: Math.round(projectedAnnualGci),
    paceAnnualizedGci: Math.round(paceAnnualizedGci),
    goal,
    projectedVsGoal: projectedVsGoal != null ? Math.round(projectedVsGoal) : null,
    yearElapsed: Math.round(yearElapsed * 1000) / 1000,
  }
}

// ── capDistance (pure) ────────────────────────────────────────────────────────

/**
 * PURE. Distance to the commission cap. When `cap` is null/≤0 the cap is UNCONFIGURED —
 * distanceToCap/progress are null and isCapped is false (we never invent a cap).
 */
export function capDistance(gciYtd: number, cap: number | null): CapStatus {
  const gci = Math.max(0, Number(gciYtd) || 0)
  if (cap == null || !Number.isFinite(cap) || cap <= 0) {
    return { cap: null, gciYtd: gci, distanceToCap: null, isCapped: false, progress: null }
  }
  const distance = Math.max(0, cap - gci)
  return {
    cap,
    gciYtd: gci,
    distanceToCap: Math.round(distance),
    isCapped: gci >= cap,
    progress: Math.min(1, Math.round((gci / cap) * 1000) / 1000),
  }
}

// ── dealsToPush (pure) ────────────────────────────────────────────────────────

/**
 * PURE. Pick the 1-2 highest-LEVERAGE near-close deals that would close `gap` (the
 * dollars needed to hit the cap or goal). "Highest leverage" = nearest to closing
 * (stage) with the largest weighted commission — a deal already at closing-prep that
 * single-handedly closes the gap beats two long-shots. Returns up to 2 deals. When
 * `gap` ≤ 0 (already there) returns []. Never fabricates — only ranks real deals.
 */
export function dealsToPush(pipeline: PipelineDeal[], gap: number): PipelineDeal[] {
  if (!(gap > 0) || pipeline.length === 0) return []

  // Rank by leverage: weighted commission × stage proximity. The probability-weighted
  // commission is the expected dollars; the stage multiplier favors deals that can
  // actually close this quarter.
  const scored = pipeline.map((d) => {
    const weighted = Math.max(0, Number(d.estimatedCommission) || 0) * normalizeWinProbability(d.winProbability, d.stage)
    const leverage = STAGE_LEVERAGE[d.stage ?? ""] ?? 0
    return { deal: d, weighted, score: weighted * (1 + leverage) }
  }).sort((a, b) => b.score - a.score)

  // Prefer the single deal that closes the gap on its own (least disruption); otherwise
  // take the top 2 by leverage.
  const single = scored.find((s) => s.weighted >= gap)
  if (single) return [single.deal]
  return scored.slice(0, 2).map((s) => s.deal)
}

// ── Summary composition (pure) ────────────────────────────────────────────────

export interface ForecastSummary {
  subject: string
  body: string
}

const usd = (n: number) => `$${Math.round(n).toLocaleString()}`

/**
 * PURE. The agent-facing brief tying it together — every line earned from real numbers.
 * Cap line appears ONLY when a cap is configured (else an honest "cap unconfigured"
 * note). Goal line appears only when a goal is set. The push recommendation appears
 * only when there are real deals to push toward a real gap.
 */
export function composeForecastSummary(
  agentName: string,
  forecast: GciForecast,
  cap: CapStatus,
  push: PipelineDeal[],
): ForecastSummary {
  const lines: string[] = []
  lines.push(
    `You've booked ${usd(forecast.closedYtd)} GCI year-to-date, with ${usd(forecast.weightedPipeline)} more weighted in your pipeline — projecting ${usd(forecast.projectedAnnualGci)} GCI for the year (run-rate pace: ${usd(forecast.paceAnnualizedGci)}).`,
  )

  if (forecast.goal != null) {
    if (forecast.projectedVsGoal != null && forecast.projectedVsGoal >= 0) {
      lines.push(`That puts you ${usd(forecast.projectedVsGoal)} AHEAD of your ${usd(forecast.goal)} goal.`)
    } else if (forecast.projectedVsGoal != null) {
      lines.push(`You're ${usd(Math.abs(forecast.projectedVsGoal))} short of your ${usd(forecast.goal)} goal on current projection.`)
    }
  }

  if (cap.cap != null) {
    if (cap.isCapped) {
      lines.push(`You've HIT your ${usd(cap.cap)} cap — every dollar from here keeps more in your pocket.`)
    } else {
      lines.push(`You're ${usd(cap.distanceToCap ?? 0)} from your ${usd(cap.cap)} commission cap (${Math.round((cap.progress ?? 0) * 100)}% there).`)
    }
  } else {
    lines.push(`Your commission cap isn't configured yet — set it and I'll track your distance to it. For now this is GCI/pace only.`)
  }

  if (push.length > 0) {
    const names = push.map((d) => d.name).join(" and ")
    const target = cap.cap != null && !cap.isCapped ? "hit your cap" : forecast.goal != null ? "close your goal gap" : "move the needle most"
    lines.push(`Highest-leverage move: push ${names} — ${push.length === 1 ? "it's" : "they're"} nearest to closing and would ${target} this quarter.`)
  }

  const subject = cap.cap != null && !cap.isCapped
    ? `💰 ${usd(cap.distanceToCap ?? 0)} from your cap — your forecast`
    : `💰 On pace for ${usd(forecast.projectedAnnualGci)} GCI — your forecast`

  return { subject, body: lines.join(" ") }
}

// ── Recruiting classification (pure) ─────────────────────────────────────────

/**
 * PURE. Decide whether an agent's forecast is a RECRUITING signal — strictly from the
 * already-computed capStatus / forecast / closedYtd (NEVER recomputed). Two outcomes the
 * Recruiting Manager (who "manages agents") cares about, else null (the healthy middle):
 *
 *  · 'crushed'  — the agent has HIT or crossed their commission cap (isCapped). Real
 *                 production proof a recruiter can cite to talent: "agents here hit and
 *                 blow past cap." Requires a CONFIGURED cap (no cap → never crushed).
 *
 *  · 'stalling' — a coaching trigger. Either:
 *                   (a) real pipeline exists but the year is projected to BADLY miss the
 *                       goal (projectedVsGoal ≤ −STALL_GOAL_MISS_FRACTION × goal), OR
 *                   (b) real pipeline exists but cap progress is deep into the year yet
 *                       very low (cap configured, progress ≤ STALL_CAP_PROGRESS, well past
 *                       year start), OR
 *                   (c) ZERO closed YTD with only a THIN pipeline (≤ STALL_THIN_PIPELINE
 *                       weighted dollars) — at risk of a no-production year.
 *                 A capped agent is NEVER stalling (crushed wins).
 *
 *  · null       — healthy mid-progress, or nothing real to say.
 *
 * Boundaries are intentionally conservative: we'd rather stay silent than mislabel a
 * productive agent as stalling. No fabrication — only the real numbers decide.
 */
export const STALL_GOAL_MISS_FRACTION = 0.4
export const STALL_CAP_PROGRESS = 0.25
export const STALL_THIN_PIPELINE = 5_000

export function classifyAgentForRecruiting(
  capStatus: CapStatus,
  forecast: GciForecast,
  closedYtd: number,
): "crushed" | "stalling" | null {
  const closed = Math.max(0, Number(closedYtd) || 0)

  // CRUSHED — post-cap (cap must be configured for isCapped to be true).
  if (capStatus.isCapped) return "crushed"

  const weighted = Math.max(0, Number(forecast.weightedPipeline) || 0)
  const hasRealPipeline = weighted > 0

  // (a) Real pipeline but projected to BADLY miss a real goal.
  if (
    hasRealPipeline &&
    forecast.goal != null &&
    forecast.goal > 0 &&
    forecast.projectedVsGoal != null &&
    forecast.projectedVsGoal <= -(STALL_GOAL_MISS_FRACTION * forecast.goal)
  ) {
    return "stalling"
  }

  // (b) Cap configured, well into the year, yet cap progress is very low despite pipeline.
  if (
    hasRealPipeline &&
    capStatus.cap != null &&
    capStatus.progress != null &&
    capStatus.progress <= STALL_CAP_PROGRESS &&
    forecast.yearElapsed >= 0.4
  ) {
    return "stalling"
  }

  // (c) Zero closed YTD with only a thin pipeline → at risk of a no-production year.
  if (closed <= 0 && weighted > 0 && weighted <= STALL_THIN_PIPELINE) {
    return "stalling"
  }

  return null
}

// ── Pipeline normalization (pure) ─────────────────────────────────────────────

interface RawTxn {
  id: string
  deal_name: string | null
  property_address: string | null
  estimated_commission: number | null
  commission_amount: number | null
  commission_percentage: number | null
  purchase_price: number | null
  win_probability: number | null
  stage: string | null
  status: string | null
  close_date: string | null
  estimated_close_date: string | null
}

/** PURE. Best-effort expected commission for a deal, never null: estimated_commission →
 *  commission_amount → purchase_price × commission_percentage% → 0. */
export function dealCommission(t: {
  estimated_commission: number | null
  commission_amount: number | null
  commission_percentage: number | null
  purchase_price: number | null
}): number {
  if (t.estimated_commission != null && Number(t.estimated_commission) > 0) return Number(t.estimated_commission)
  if (t.commission_amount != null && Number(t.commission_amount) > 0) return Number(t.commission_amount)
  if (t.purchase_price != null && t.commission_percentage != null) {
    return Math.max(0, Number(t.purchase_price) * (Number(t.commission_percentage) / 100))
  }
  return 0
}

/** PURE. Fold raw transaction rows into the in-progress pipeline shape. */
export function toPipeline(rows: RawTxn[]): PipelineDeal[] {
  return rows.map((t) => ({
    id: t.id,
    name: t.deal_name ?? t.property_address ?? "Deal",
    estimatedCommission: dealCommission(t),
    winProbability: normalizeWinProbability(t.win_probability, t.stage),
    stage: t.stage,
    expectedCloseDate: t.estimated_close_date ?? t.close_date,
  }))
}

// ── The live runner ───────────────────────────────────────────────────────────

const IN_PROGRESS_STATUSES = ["active", "under_contract", "closing"] as const

export interface CommissionForecasterResult {
  agentsConsidered: number
  forecastsProposed: number
  audioBriefs: number
  textBriefs: number
  capsConfigured: number
  /** Recruiting-bus signals emitted to recruiting_manager for agents who HIT/crossed cap
   *  (recruiting PROOF datapoints the recruiter can cite to talent). */
  recruitingProofSignals: number
  /** Recruiting-bus COACHING signals emitted to recruiting_manager for stalling agents
   *  (real pipeline but projected to badly miss, or zero production with a thin pipeline). */
  coachingSignals: number
  errors: string[]
}

/** The real synthesizer seam — reuses the whisper TTS rail; null → text fallback. */
const realSynthesizer: WhisperSynthesizer = async (script, voiceId) => {
  try {
    const { synthesizeSpeechStream } = await import("@/lib/voice/elevenlabs-tts")
    const res = await synthesizeSpeechStream({ text: script, voiceId })
    return (res as { audioUrl?: string | null })?.audioUrl ?? null
  } catch { return null }
}

/** Resolve the agent's configured commission cap (OPTIONAL): agents.cap_amount first,
 *  then the current agent_cap_tracking window's cap_amount. Null when unconfigured. */
async function resolveCap(supabase: Svc, agentId: string, now: Date): Promise<number | null> {
  const { data: a } = await supabase.from("agents").select("cap_amount").eq("id", agentId).maybeSingle()
  const direct = (a as { cap_amount: number | null } | null)?.cap_amount ?? null
  if (direct != null && Number(direct) > 0) return Number(direct)
  const today = now.toISOString().slice(0, 10)
  const { data: track } = await supabase
    .from("agent_cap_tracking").select("cap_amount, anniversary_start, anniversary_end")
    .eq("agent_id", agentId).lte("anniversary_start", today).gte("anniversary_end", today)
    .order("anniversary_start", { ascending: false }).limit(1).maybeSingle()
  const tracked = (track as { cap_amount: number | null } | null)?.cap_amount ?? null
  return tracked != null && Number(tracked) > 0 ? Number(tracked) : null
}

/**
 * Per-agent commission & cap forecast for a brokerage. For each active agent:
 *  1) sum CLOSED-YTD GCI (transactions.commission_amount, status='closed', close_date ≥ Jan 1)
 *  2) build the in-progress pipeline (active/under_contract/closing) weighted by win prob
 *  3) read the OPTIONAL cap + the OPTIONAL gross_commission goal
 *  4) forecast → cap distance → 1-2 deals to push
 *  5) propose ONE gated agent-facing summary (audience 'agent', deal_coordinator),
 *     with an optional audio brief in the agent's configured assistant voice.
 *
 * IDEMPOTENT: one forecast per agent per ISO week (keyed on the agent_client_messages
 * rationale carrying the week tag). NOT server-only.
 */
export async function runCommissionForecaster(
  brokerageId: string,
  opts: { now?: Date; synthesizer?: WhisperSynthesizer } = {},
  client?: Svc,
): Promise<CommissionForecasterResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const synthesizer = opts.synthesizer ?? realSynthesizer
  const result: CommissionForecasterResult = {
    agentsConsidered: 0, forecastsProposed: 0, audioBriefs: 0, textBriefs: 0, capsConfigured: 0,
    recruitingProofSignals: 0, coachingSignals: 0, errors: [],
  }

  const weekTag = isoWeekTag(now)
  const year = now.getUTCFullYear()
  const yearStart = new Date(Date.UTC(year, 0, 1)).toISOString().slice(0, 10)

  const { data: agentRows, error: agentErr } = await supabase
    .from("agents").select("id, user_id").eq("brokerage_id", brokerageId).eq("active", true).limit(2000)
  if (agentErr) { result.errors.push(`agents: ${agentErr.message}`); return result }
  const agents = (agentRows ?? []) as Array<{ id: string; user_id: string | null }>

  for (const agent of agents) {
    result.agentsConsidered += 1
    try {
      // Idempotency — one forecast per agent per ISO week.
      const { data: already } = await supabase.from("agent_client_messages").select("id")
        .eq("brokerage_id", brokerageId).eq("agent_kind", "deal_coordinator").eq("entity_type", "transaction")
        .ilike("rationale", `COMMISSION FORECAST ${weekTag}%agent:${agent.id}%`).limit(1).maybeSingle()
      if (already) continue

      // 1) Closed YTD GCI.
      const { data: closedRows } = await supabase.from("transactions")
        .select("commission_amount, estimated_commission, commission_percentage, purchase_price")
        .eq("brokerage_id", brokerageId).eq("agent_id", agent.id).eq("status", "closed")
        .gte("close_date", yearStart).limit(5000)
      const closedYtd = ((closedRows ?? []) as RawTxn[]).reduce(
        (s, t) => s + (Number(t.commission_amount) > 0 ? Number(t.commission_amount) : dealCommission(t)), 0,
      )

      // 2) In-progress pipeline.
      const { data: pipeRows } = await supabase.from("transactions")
        .select("id, deal_name, property_address, estimated_commission, commission_amount, commission_percentage, purchase_price, win_probability, stage, status, close_date, estimated_close_date")
        .eq("brokerage_id", brokerageId).eq("agent_id", agent.id).in("status", IN_PROGRESS_STATUSES as unknown as string[])
        .limit(5000)
      const pipeline = toPipeline((pipeRows ?? []) as RawTxn[])

      // Nothing to forecast at all → skip honestly (don't propose an empty brief).
      if (closedYtd <= 0 && pipeline.length === 0) continue

      // 3) Optional cap + goal.
      const cap = await resolveCap(supabase, agent.id, now)
      if (cap != null) result.capsConfigured += 1
      const { data: goalRow } = await supabase.from("agent_goals")
        .select("target_value").eq("agent_id", agent.id).eq("year", year).eq("goal_type", "gross_commission")
        .maybeSingle()
      const goal = (goalRow as { target_value: number | null } | null)?.target_value ?? null

      // 4) Forecast → cap → push.
      const forecast = forecastGci(closedYtd, pipeline, now, goal != null ? Number(goal) : null)
      const capStatus = capDistance(closedYtd, cap)
      // Gap to close: prefer the cap distance, else the goal shortfall, else 0.
      const gap = capStatus.distanceToCap != null && !capStatus.isCapped
        ? capStatus.distanceToCap
        : forecast.goal != null && forecast.projectedVsGoal != null && forecast.projectedVsGoal < 0
          ? -forecast.projectedVsGoal
          : 0
      const push = dealsToPush(pipeline, gap)

      // Agent name + tier inputs (for the optional assistant-voice audio).
      let agentName = "there"
      let userType = "agent"
      let userBrokerage: string | undefined
      let userTeam: string | undefined
      if (agent.user_id) {
        const { data: u } = await supabase.from("users").select("first_name, last_name, user_type, brokerage_id, team_id").eq("id", agent.user_id).maybeSingle()
        const uu = u as { first_name: string | null; last_name: string | null; user_type: string | null; brokerage_id: string | null; team_id: string | null } | null
        agentName = [uu?.first_name, uu?.last_name].filter(Boolean).join(" ").trim() || "there"
        userType = uu?.user_type ?? "agent"
        userBrokerage = uu?.brokerage_id ?? undefined
        userTeam = uu?.team_id ?? undefined
      }

      const summary = composeForecastSummary(agentName, forecast, capStatus, push)

      // 5a) OPTIONAL audio in the agent's CONFIGURED assistant voice (text otherwise).
      let audioUrl: string | null = null
      if (agent.user_id) {
        const tier = mapUserTypeToTier(userType, userBrokerage, userTeam)
        if (whisperTierCapability(tier) === "audio") {
          const voiceId = await resolveAssistantVoiceId(supabase, agent.user_id)
          if (voiceId) audioUrl = await synthesizer(summary.body, voiceId)
        }
      }

      // 5b) Gated agent-facing proposal — one per agent per week. Pick a representative
      // transaction as the entity (a push target, else any pipeline deal) so the gate can
      // resolve the responsible agent and deep-link.
      const entityId = push[0]?.id ?? pipeline[0]?.id ?? null
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage({
        brokerageId, agentKind: "deal_coordinator", entityType: "transaction", entityId,
        audience: "agent",
        subject: summary.subject,
        body: audioUrl ? `${summary.body}\n\n▶ Listen: ${audioUrl}` : summary.body,
        rationale: `COMMISSION FORECAST ${weekTag} — agent:${agent.id} — closed YTD ${Math.round(forecast.closedYtd)}, weighted pipeline ${forecast.weightedPipeline}, projected ${forecast.projectedAnnualGci}${cap != null ? `, cap ${cap}` : ", cap unconfigured"}${goal != null ? `, goal ${goal}` : ""}; gated agent brief.`,
        channel: "portal",
      }, supabase)
      if (res.ok) {
        result.forecastsProposed += 1
        if (audioUrl) result.audioBriefs += 1; else result.textBriefs += 1

        // ── Loop the Recruiting Manager into agent-management via the inter-manager bus ──
        // Decide crushing vs stalling vs neither from the ALREADY-COMPUTED capStatus/forecast
        // (no recompute). GATED/observational: we only publish an INTERNAL bus signal — the
        // recruiting handler decides what to do; nothing here messages any agent autonomously.
        // Idempotent: the bus dedupes on (recruiting_manager, signalType, agent.id) → at most
        // one OPEN signal per agent per outcome.
        const recruitingClass = classifyAgentForRecruiting(capStatus, forecast, forecast.closedYtd)
        if (recruitingClass) {
          try {
            const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
            const basePayload = {
              agent_id: agent.id,
              user_id: agent.user_id,
              closed_ytd: Math.round(forecast.closedYtd),
              cap: capStatus.cap,
              projected_annual_gci: forecast.projectedAnnualGci,
              cap_progress: capStatus.progress,
              goal: forecast.goal,
              projected_vs_goal: forecast.projectedVsGoal,
              week: weekTag,
            }
            if (recruitingClass === "crushed") {
              const sig = await publishManagerSignal({
                brokerageId, fromManager: "deal_coordinator", toManager: "recruiting_manager",
                signalType: "agent_crushed_cap", entityType: "agent", entityId: agent.id,
                message: `${agentName} hit their ${cap != null ? usd(cap) : "commission"} cap (${usd(forecast.closedYtd)} GCI closed YTD) — live proof for the recruiting pitch that agents here hit and blow past cap.`,
                payload: basePayload,
              }, supabase)
              if (sig.ok) result.recruitingProofSignals += 1
            } else {
              const sig = await publishManagerSignal({
                brokerageId, fromManager: "deal_coordinator", toManager: "recruiting_manager",
                signalType: "agent_stalling", entityType: "agent", entityId: agent.id,
                message: `${agentName} is tracking behind — ${usd(forecast.closedYtd)} GCI closed YTD, projecting ${usd(forecast.projectedAnnualGci)}${forecast.goal != null ? ` against a ${usd(forecast.goal)} goal` : ""}. Worth a coaching touch from the management side.`,
                payload: basePayload,
              }, supabase)
              if (sig.ok) result.coachingSignals += 1
            }
          } catch (sigErr: any) {
            result.errors.push(`agent ${agent.id} recruiting signal: ${sigErr?.message ?? String(sigErr)}`)
          }
        }
      } else if (res.error) {
        result.errors.push(`agent ${agent.id}: ${res.error}`)
      }
    } catch (e: any) {
      result.errors.push(`agent ${agent.id}: ${e?.message ?? String(e)}`)
    }
  }

  return result
}

/** ISO-week tag (e.g. "2026-W24") for the per-agent-per-week idempotency key. PURE. */
export function isoWeekTag(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}
