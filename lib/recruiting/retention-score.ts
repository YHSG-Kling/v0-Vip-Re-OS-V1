// lib/recruiting/retention-score.ts
//
// AGENT RETENTION SCORE — the defensive mirror of the switch-propensity scout. Where that scores which
// EXTERNAL agents to recruit, this scores YOUR OWN agents' flight risk so a slipping agent gets a save
// play BEFORE they walk. Built from REAL engagement signals the live app already has — no fabricated
// telemetry: activity recency (assistant/platform use), production drought (days since last closing),
// active pipeline, and onboarding ramp. HONEST: a signal with no data is neutral (0.5), not counted as
// a failure, and the weights renormalize over the signals we actually have. Pure + unit-tested.

export interface RetentionSignals {
  /** Days since the agent's last platform/assistant activity (null = unknown → neutral). */
  daysSinceActivity: number | null
  /** Days since the agent's last CLOSED deal (null = never closed / unknown). */
  daysSinceClosing: number | null
  /** Count of the agent's ACTIVE in-flight transactions. */
  activePipeline: number | null
  /** Onboarding completion 0..100 (null = not onboarding / unknown → neutral). */
  onboardingPct: number | null
  /** Days since the agent joined (young agents in a production drought aren't as alarming). */
  tenureDays: number | null
  /** Gamification points earned in the last 30 days (null = unknown → neutral). Engaged, competing agents
   *  are near-zero flight risk — the spec's gamification→retention feed. */
  gamificationPoints30d?: number | null

  // ── WAVE 89 (lane 89C) — AGENT FATIGUE SIGNALS ─────────────────────────────
  // Owner, verbatim: "brokerages need agent fatigue signals so they can give the support that they are
  // lacking before they decide to leave." Every one is derived from data the app already tracks; every
  // one is OPTIONAL (absent → dropped + renormalized, so a radar row built before wave 89 scores exactly
  // as it did). None of these is ever agent-facing as "you're at risk" — they feed the broker's board,
  // the broker-facing coaching digest and the support nudge (lib/recruiting/retention-radar.ts).
  /** Median hours from a client's inbound message to the agent's next reply (30d). null = no pairs. */
  responseLagHours?: number | null
  /** Client inbound messages older than the reply window with no agent reply after them (30d). */
  unansweredClientMessages?: number | null
  /** Appointments on the agent's calendar in the window, and how many were missed / rescheduled. */
  appointments30d?: number | null
  missedOrRescheduled30d?: number | null
  /** Platform sessions in the last 14 days vs the 14 before — a falling ratio is the "quiet quit". */
  sessionsLast14d?: number | null
  sessionsPrior14d?: number | null
  /** Follow-up tasks assigned to the agent that are past due and not completed. */
  overdueTasks?: number | null
  /** The active pipeline ~30 days ago (from the stored raw signals) — a shrinking pipeline is confirmation. */
  activePipelinePrior?: number | null
  /** High / critical contact fatigue on the agent's book, over the contacts on that book. */
  fatiguedContacts?: number | null
  bookContacts?: number | null
  /** Book transfers away from this agent in the last 90 days (temporary cover or permanent). */
  bookTransfers90d?: number | null
}

/** A client message unanswered past this many hours counts against the agent (the industry
 *  speed-to-lead bar is minutes; two days is the point at which a client feels ignored). */
export const CLIENT_REPLY_WINDOW_HOURS = 48
/** Appointment-miss rate needs at least this many appointments before it earns a verdict
 *  (the same sample floor lib/kernel/agent-coaching.ts MIN_SAMPLE uses for no-shows). */
export const FATIGUE_MIN_APPOINTMENTS = 3
/** Share of a book at high/critical contact fatigue that reads as a fully fatigued book. */
export const FATIGUED_BOOK_FULL_SHARE = 0.3

/** The fatigue signal keys (the wave-89 sub-scores) — the support nudge counts weak ones among THESE. */
export const AGENT_FATIGUE_SIGNAL_KEYS = [
  "response_lag", "unanswered_clients", "missed_appointments", "activity_trend",
  "overdue_tasks", "pipeline_drop", "fatigued_book", "book_transfers",
] as const
export type AgentFatigueSignalKey = (typeof AGENT_FATIGUE_SIGNAL_KEYS)[number]

/** Driving-signal labels per fatigue key — ONE spelling, read by the intervention library. */
export const AGENT_FATIGUE_LABELS: Record<AgentFatigueSignalKey, string> = {
  response_lag:        "Slow to answer clients",
  unanswered_clients:  "Client messages going unanswered",
  missed_appointments: "Missing or rescheduling appointments",
  activity_trend:      "Platform activity falling off",
  overdue_tasks:       "Follow-up tasks overdue",
  pipeline_drop:       "Pipeline shrinking",
  fatigued_book:       "A fatigued book — contacts not answering",
  book_transfers:      "Book recently transferred or covered",
}

export type RetentionTier = "engaged" | "healthy" | "watch" | "at_risk" | "critical"

export interface RetentionScore {
  /** 0 (about to leave) .. 100 (fully engaged). */
  score: number
  tier: RetentionTier
  /** The lowest sub-scores dragging the agent down (human-readable). */
  drivingSignals: string[]
  /** Per-signal sub-scores (0..1) for the score row's breakdown. */
  breakdown: Record<string, number>
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** Recency → 0..1 (fresh = 1). null → neutral 0.5 (unknown, not a failure). */
function recencyScore(days: number | null, fullByDays: number): number | null {
  if (days == null || !Number.isFinite(days)) return null
  if (days <= 0) return 1
  return clamp01(1 - days / fullByDays)
}

/**
 * PURE: composite retention score from the signals we can honestly source. Each present signal is a
 * 0..1 sub-score; absent signals are dropped and the remaining weights renormalize (so an agent isn't
 * punished for data we don't have). Production drought is softened for brand-new agents (tenure < 60d),
 * who haven't had time to close.
 */
export function computeRetentionScore(sig: RetentionSignals): RetentionScore {
  const parts: Array<{ key: string; label: string; weight: number; sub: number | null }> = []

  // 1. Activity recency — the strongest engagement signal (haven't logged in ⇒ checked out).
  parts.push({ key: "activity", label: "Low platform activity", weight: 0.32, sub: recencyScore(sig.daysSinceActivity, 21) })

  // 2. Production drought — days since last closing; softened for very new agents.
  let droughtSub = recencyScore(sig.daysSinceClosing, 180)
  const isNew = sig.tenureDays != null && sig.tenureDays < 60
  if (droughtSub != null && isNew) droughtSub = clamp01(droughtSub * 0.4 + 0.6) // new agents: floor the penalty
  parts.push({ key: "production", label: "In a production drought", weight: 0.28, sub: droughtSub })

  // 3. Active pipeline — has something in flight (0 = concerning).
  const pipeSub = sig.activePipeline == null ? null : clamp01(Math.min(1, sig.activePipeline / 2))
  parts.push({ key: "pipeline", label: "Empty pipeline", weight: 0.25, sub: pipeSub })

  // 4. Onboarding ramp — a stalled ramp is an early flight signal.
  const rampSub = sig.onboardingPct == null ? null : clamp01(sig.onboardingPct / 100)
  parts.push({ key: "onboarding", label: "Stalled onboarding", weight: 0.15, sub: rampSub })

  // 5. Gamification engagement — points in the last 30d; 500+ = fully engaged. Competing agents rarely
  //    leave. Absent (null) → dropped + renormalized (identical to the prior 4-signal behavior).
  const gamePts = sig.gamificationPoints30d
  const gameSub = gamePts == null ? null : clamp01(Math.min(1, gamePts / 500))
  parts.push({ key: "gamification", label: "Low activity/engagement momentum", weight: 0.10, sub: gameSub })

  // ── WAVE 89 (lane 89C) — the fatigue signals. Each is a 0..1 sub-score in the SAME frame (1 = no
  //    fatigue), dropped when its input is absent, so the five signals above keep their behaviour.
  for (const f of agentFatigueSubScores(sig)) {
    parts.push({ key: f.key, label: AGENT_FATIGUE_LABELS[f.key], weight: f.weight, sub: f.sub })
  }

  const present = parts.filter((p) => p.sub != null)
  const totalWeight = present.reduce((s, p) => s + p.weight, 0) || 1
  const composite = present.reduce((s, p) => s + p.weight * (p.sub as number), 0) / totalWeight
  const score = Math.round(clamp01(composite) * 100)

  const breakdown: Record<string, number> = {}
  for (const p of parts) if (p.sub != null) breakdown[p.key] = Math.round((p.sub as number) * 100) / 100

  // Driving signals = the lowest present sub-scores (only genuinely weak ones, < 0.5).
  const drivingSignals = present
    .filter((p) => (p.sub as number) < 0.5)
    .sort((a, b) => (a.sub as number) - (b.sub as number))
    .slice(0, 3)
    .map((p) => p.label)

  return { score, tier: scoreTier(score), drivingSignals, breakdown }
}

/**
 * PURE (wave 89, lane 89C): the fatigue sub-scores, 0..1 in the retention frame (1 = fine, 0 = the
 * signal is fully lit). A signal whose input is absent is NULL — never a fabricated failure. Every
 * threshold is documented on the constant it reads.
 *   response_lag        1 − lag / (2 × CLIENT_REPLY_WINDOW_HOURS): a same-day reply ≈ 1, four days ≈ 0
 *   unanswered_clients  1 − n / 5: five ignored client messages in a month is a fully lit signal
 *   missed_appointments 1 − missed / appointments, only once FATIGUE_MIN_APPOINTMENTS are on the calendar
 *   activity_trend      last14 / prior14 capped at 1; no sessions either fortnight = null (nothing to trend)
 *   overdue_tasks       1 − n / 10
 *   pipeline_drop       1 when the pipeline held or grew; else the fraction that remains
 *   fatigued_book       1 − share / FATIGUED_BOOK_FULL_SHARE (share = fatigued / contacts on the book)
 *   book_transfers      0 when a transfer away from the agent landed in the window, else 1
 */
export function agentFatigueSubScores(sig: RetentionSignals): Array<{ key: AgentFatigueSignalKey; weight: number; sub: number | null }> {
  const num = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : v)
  const lag = num(sig.responseLagHours)
  const unanswered = num(sig.unansweredClientMessages)
  const appts = num(sig.appointments30d)
  const missed = num(sig.missedOrRescheduled30d)
  const last14 = num(sig.sessionsLast14d)
  const prior14 = num(sig.sessionsPrior14d)
  const overdue = num(sig.overdueTasks)
  const pipeNow = num(sig.activePipeline)
  const pipePrior = num(sig.activePipelinePrior)
  const fatigued = num(sig.fatiguedContacts)
  const book = num(sig.bookContacts)
  const transfers = num(sig.bookTransfers90d)

  const apptSub = appts != null && missed != null && appts >= FATIGUE_MIN_APPOINTMENTS ? clamp01(1 - missed / appts) : null
  const trendSub = last14 != null && prior14 != null && (last14 > 0 || prior14 > 0)
    ? (prior14 === 0 ? 1 : clamp01(last14 / prior14))
    : null
  const pipeSub = pipeNow != null && pipePrior != null
    ? (pipeNow >= pipePrior || pipePrior === 0 ? 1 : clamp01(pipeNow / pipePrior))
    : null
  const bookSub = fatigued != null && book != null && book > 0 ? clamp01(1 - (fatigued / book) / FATIGUED_BOOK_FULL_SHARE) : null

  return [
    { key: "response_lag",        weight: 0.15, sub: lag == null ? null : clamp01(1 - lag / (2 * CLIENT_REPLY_WINDOW_HOURS)) },
    { key: "unanswered_clients",  weight: 0.12, sub: unanswered == null ? null : clamp01(1 - unanswered / 5) },
    { key: "missed_appointments", weight: 0.12, sub: apptSub },
    { key: "activity_trend",      weight: 0.10, sub: trendSub },
    { key: "overdue_tasks",       weight: 0.08, sub: overdue == null ? null : clamp01(1 - overdue / 10) },
    { key: "pipeline_drop",       weight: 0.10, sub: pipeSub },
    { key: "fatigued_book",       weight: 0.10, sub: bookSub },
    { key: "book_transfers",      weight: 0.05, sub: transfers == null ? null : (transfers > 0 ? 0 : 1) },
  ]
}

/** PURE: the fatigue signals that are WEAK (< 0.5) in a stored breakdown — the count the support nudge
 *  reads ("one signal is worth watching, two is worth a direct conversation"). */
export function weakFatigueSignals(breakdown: Record<string, number> | null | undefined): AgentFatigueSignalKey[] {
  if (!breakdown || typeof breakdown !== "object") return []
  return AGENT_FATIGUE_SIGNAL_KEYS.filter((k) => {
    const v = Number(breakdown[k])
    return Number.isFinite(v) && v < 0.5
  })
}

/** Two lit fatigue signals = a support conversation (before the score itself reads at-risk). */
export const SUPPORT_NUDGE_MIN_SIGNALS = 2

/** PURE: bucket a score into a retention tier. */
export function scoreTier(score: number): RetentionTier {
  if (score >= 80) return "engaged"
  if (score >= 60) return "healthy"
  if (score >= 40) return "watch"
  if (score >= 20) return "at_risk"
  return "critical"
}

/** PURE: is this an at-risk agent worth a broker save play? (watch tier and below.) */
export const AT_RISK_THRESHOLD = 40
export function isAtRisk(score: number): boolean {
  return score < AT_RISK_THRESHOLD
}

/** PURE: trend from the previous day's score. */
export function scoreTrendOf(current: number, previous: number | null): "improving" | "stable" | "declining" {
  if (previous == null) return "stable"
  if (current > previous + 2) return "improving"
  if (current < previous - 2) return "declining"
  return "stable"
}
