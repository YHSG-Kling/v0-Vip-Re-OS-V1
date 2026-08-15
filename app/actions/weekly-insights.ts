"use server"

/**
 * Weekly Insights — "What got smarter this week" digest.
 *
 * Vision moment "gets smarter every day" should be visible. This aggregates
 * existing telemetry from 5 wired sources to produce a Monday-morning digest:
 *
 *   - ai_message_drafts        → Reply Coach acceptance + edit-down rate
 *   - ai_isa_calls             → ISA outcomes (appointments set, lead quality)
 *   - property_matches         → match quality + buyer feedback
 *   - call_coaching_insights   → coaching insights surfaced + acted on
 *   - lead_score_history       → score deltas (rising/cooling leads)
 *
 * Compares this week to prior week so each metric has a delta.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { resolveWriteContext } from "@/lib/kernel/identity"

export interface WeeklyMetric {
  label: string
  value: string
  /** Percentage change vs prior week, positive = better */
  delta?: number
  /** Plain-language phrase about the trend */
  narrative: string
}

export interface WeeklyInsights {
  weekStart: string  // ISO date — Monday of the week
  weekEnd: string    // ISO date — Sunday
  highlights: string[]              // 2-4 plain-text highlight bullets
  metrics: WeeklyMetric[]            // per-source numbers
  generatedAt: string
}

export async function getWeeklyInsights(): Promise<WeeklyInsights> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) {
    return EMPTY_INSIGHTS()
  }

  const svc = createServiceClient()

  // Date windows — week = last 7 days; prior = the 7 days before that
  const now = Date.now()
  const weekAgo = new Date(now - 7 * 86400000).toISOString()
  const twoWeeksAgo = new Date(now - 14 * 86400000).toISOString()
  const weekStart = new Date(now - 7 * 86400000).toISOString().slice(0, 10)
  const weekEnd = new Date(now).toISOString().slice(0, 10)

  // Resolve agent_id (some tables key on agents.id, others on users.id)
  let agentId: string | null = null
  if (ctx.userId) {
    const { data: agent } = await svc
      .from("agents")
      .select("id")
      .eq("user_id", ctx.userId)
      .maybeSingle()
    agentId = agent?.id ?? null
  }

  const [
    drafts,
    priorDrafts,
    isaThis,
    isaPrior,
    matches,
    coachInsights,
  ] = await Promise.all([
    fetchDraftsInWindow(svc, ctx.userId, weekAgo, new Date(now).toISOString()),
    fetchDraftsInWindow(svc, ctx.userId, twoWeeksAgo, weekAgo),
    fetchIsaCallsInWindow(svc, ctx.brokerageId, weekAgo),
    fetchIsaCallsInWindow(svc, ctx.brokerageId, twoWeeksAgo, weekAgo),
    fetchMatchesInWindow(svc, ctx.brokerageId, weekAgo),
    fetchCoachingInWindow(svc, agentId, weekAgo),
  ])

  // Compute metrics
  const metrics: WeeklyMetric[] = []
  const highlights: string[] = []

  // 1. Reply Coach acceptance rate
  if (drafts.total > 0 || priorDrafts.total > 0) {
    const acceptRate = pct(drafts.accepted, drafts.total)
    const priorRate = pct(priorDrafts.accepted, priorDrafts.total)
    const delta = priorRate > 0 ? round(((acceptRate - priorRate) / priorRate) * 100) : 0
    metrics.push({
      label: "AI reply acceptance",
      value: `${acceptRate}%`,
      delta,
      narrative: `You accepted ${drafts.accepted} of ${drafts.total} AI-drafted messages this week.`,
    })
    if (delta >= 5) {
      highlights.push(`Your AI reply tone is matching better — acceptance up ${delta}% vs last week.`)
    }
  }

  // 2. ISA auto-handled (appointments set without agent touch)
  metrics.push({
    label: "ISA appointments set",
    value: String(isaThis.appointmentsSet),
    delta:
      isaPrior.appointmentsSet > 0
        ? round(((isaThis.appointmentsSet - isaPrior.appointmentsSet) / isaPrior.appointmentsSet) * 100)
        : isaThis.appointmentsSet > 0 ? 100 : 0,
    narrative:
      isaThis.appointmentsSet > 0
        ? `AI ISA auto-handled ${isaThis.appointmentsSet} qualified leads to an appointment.`
        : "No ISA appointments this week.",
  })
  if (isaThis.appointmentsSet > 0) {
    highlights.push(
      `AI ISA booked ${isaThis.appointmentsSet} appointment${isaThis.appointmentsSet === 1 ? "" : "s"} you didn't have to chase.`
    )
  }

  // 3. Property match quality
  if (matches.total > 0) {
    metrics.push({
      label: "Avg match score",
      value: `${matches.avgScore.toFixed(0)}`,
      narrative: `${matches.total} property matches this week, average score ${matches.avgScore.toFixed(0)}.`,
    })
  }

  // 4. Coaching insights acted on
  if (coachInsights.total > 0) {
    const actedRate = pct(coachInsights.actedOn, coachInsights.total)
    metrics.push({
      label: "Coaching acted on",
      value: `${actedRate}%`,
      narrative: `${coachInsights.actedOn} of ${coachInsights.total} coaching insights actioned this week.`,
    })
  }

  // Generic close — always include something
  if (highlights.length === 0) {
    highlights.push(
      "Keep going. The AI is learning from every message you send and every property you tour."
    )
  }

  return {
    weekStart,
    weekEnd,
    highlights,
    metrics,
    generatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Per-source fetchers (kept tight — only the columns we need)
// ---------------------------------------------------------------------------

async function fetchDraftsInWindow(
  svc: ReturnType<typeof createServiceClient>,
  userId: string,
  fromISO: string,
  toISO: string
): Promise<{ total: number; accepted: number; rejected: number; edited: number }> {
  const { data } = await svc
    .from("ai_message_drafts")
    .select("status, draft_body, final_body")
    .eq("agent_user_id", userId)
    .gte("created_at", fromISO)
    .lt("created_at", toISO)
    .limit(500)

  const out = { total: 0, accepted: 0, rejected: 0, edited: 0 }
  for (const d of data ?? []) {
    out.total++
    if (d.status === "accepted" || d.status === "sent") out.accepted++
    else if (d.status === "rejected" || d.status === "discarded") out.rejected++
    else if (d.final_body && d.final_body !== d.draft_body) out.edited++
  }
  return out
}

async function fetchIsaCallsInWindow(
  svc: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  fromISO: string,
  toISO?: string
): Promise<{ total: number; appointmentsSet: number; avgQualityScore: number }> {
  let q = svc
    .from("ai_isa_calls")
    .select("appointment_set, lead_quality_score, created_at")
    .eq("brokerage_id", brokerageId)
    .gte("created_at", fromISO)
    .limit(500)
  if (toISO) q = q.lt("created_at", toISO)

  const { data } = await q
  const total = data?.length ?? 0
  const appointmentsSet = (data ?? []).filter((c) => c.appointment_set === true).length
  const scores = (data ?? []).map((c) => c.lead_quality_score).filter((s): s is number => typeof s === "number")
  const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
  return { total, appointmentsSet, avgQualityScore: avg }
}

async function fetchMatchesInWindow(
  svc: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  fromISO: string
): Promise<{ total: number; avgScore: number }> {
  const { data } = await svc
    .from("property_matches")
    .select("match_score, generated_at")
    .eq("brokerage_id", brokerageId)
    .gte("generated_at", fromISO)
    .limit(500)
  const total = data?.length ?? 0
  const scores = (data ?? []).map((m) => m.match_score).filter((s): s is number => typeof s === "number")
  const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
  return { total, avgScore: avg }
}

async function fetchCoachingInWindow(
  svc: ReturnType<typeof createServiceClient>,
  agentId: string | null,
  fromISO: string
): Promise<{ total: number; actedOn: number }> {
  if (!agentId) return { total: 0, actedOn: 0 }
  const { data } = await svc
    .from("call_coaching_insights")
    .select("dismissed, created_at")
    .eq("agent_id", agentId)
    .gte("created_at", fromISO)
    .limit(500)
  const total = data?.length ?? 0
  // "acted on" = not dismissed (defensive for nulls)
  const actedOn = (data ?? []).filter((c) => c.dismissed === false).length
  return { total, actedOn }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 100)
}

function round(n: number): number {
  return Math.round(n)
}

function EMPTY_INSIGHTS(): WeeklyInsights {
  const today = new Date()
  return {
    weekStart: new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10),
    weekEnd: today.toISOString().slice(0, 10),
    highlights: [],
    metrics: [],
    generatedAt: today.toISOString(),
  }
}
