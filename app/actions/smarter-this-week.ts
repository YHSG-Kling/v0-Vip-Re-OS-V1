"use server"

/**
 * Smarter-this-week digest — aggregates the past 7 days of AI-driven
 * activity for the current agent and surfaces measurable improvement.
 *
 * Vision moment "gets smarter every day" must be VISIBLE — this surface
 * shows the agent: how many leads the AI auto-handled, how their reply
 * tone improved, what their practice score trends look like.
 *
 * All sources are existing telemetry tables — no new data collection needed.
 *
 * Data sources:
 *   - ai_message_drafts.status (accepted/edited/rejected) → Reply Coach acceptance
 *   - ai_isa_calls.appointment_set → AI-set appointments + auto-handled leads
 *   - property_matches.user_feedback → match recommendation quality
 *   - objection_training_sessions.total_score → practice score trend
 *   - call_coaching_insights → call coaching frequency
 *   - lead_score_history → distribution shifts
 */

import { resolveActingContext } from "@/lib/platform/acting-context"
import { createServiceClient } from "@/lib/supabase/service"

export interface SmarterMetric {
  key: string
  label: string
  thisWeek: number
  priorWeek: number
  delta: number              // raw delta
  deltaPercent: number | null // percent change (null if prior was 0)
  trend: "up" | "down" | "flat"
  unit: "count" | "percent" | "score"
  insight: string            // human-readable phrasing
}

export interface SmarterDigest {
  generatedAt: string
  weekStart: string
  weekEnd: string
  metrics: SmarterMetric[]
  highlight: string | null   // single most positive callout
}

export async function getSmarterThisWeek(): Promise<SmarterDigest> {
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.userId) {
    return { generatedAt: new Date().toISOString(), weekStart: "", weekEnd: "", metrics: [], highlight: null }
  }

  const svc = createServiceClient()

  const now = new Date()
  const weekEnd = now.toISOString()
  const weekStart = new Date(now.getTime() - 7 * 86400000).toISOString()
  const priorWeekStart = new Date(now.getTime() - 14 * 86400000).toISOString()

  const metrics: SmarterMetric[] = []

  // 1. Reply Coach acceptance — what % of AI message drafts the agent accepted
  // (status='sent' or 'accepted') vs total drafts produced
  const replyCoachMetric = await getReplyCoachMetric(svc, ctx.userId, weekStart, priorWeekStart, weekEnd)
  if (replyCoachMetric) metrics.push(replyCoachMetric)

  // 2. AI-set appointments — how many appointments AI ISA booked for this agent's contacts
  if (ctx.agentId) {
    const isaMetric = await getIsaAppointmentsMetric(svc, ctx.agentId, weekStart, priorWeekStart, weekEnd)
    if (isaMetric) metrics.push(isaMetric)
  }

  // 3. Match quality — avg user_feedback on property_matches for this agent's contacts
  if (ctx.agentId) {
    const matchMetric = await getMatchQualityMetric(svc, ctx.agentId, weekStart, priorWeekStart, weekEnd)
    if (matchMetric) metrics.push(matchMetric)
  }

  // 4. Objection practice — average score from objection_training_sessions
  const practiceMetric = await getPracticeScoreMetric(svc, ctx.userId, weekStart, priorWeekStart, weekEnd)
  if (practiceMetric) metrics.push(practiceMetric)

  // 5. Coaching insights — how many actionable insights were generated
  if (ctx.agentId) {
    const coachingMetric = await getCoachingInsightsMetric(svc, ctx.agentId, weekStart, priorWeekStart, weekEnd)
    if (coachingMetric) metrics.push(coachingMetric)
  }

  // Highlight: pick the metric with biggest positive percent change
  const highlight = pickHighlight(metrics)

  return {
    generatedAt: now.toISOString(),
    weekStart,
    weekEnd,
    metrics,
    highlight,
  }
}

// ─── Per-metric fetchers ─────────────────────────────────────────────────────

async function getReplyCoachMetric(
  svc: ReturnType<typeof createServiceClient>,
  agentUserId: string,
  weekStart: string, priorWeekStart: string, weekEnd: string
): Promise<SmarterMetric | null> {
  const { data: thisWeek } = await svc
    .from("ai_message_drafts")
    .select("status")
    .eq("agent_user_id", agentUserId)
    .gte("created_at", weekStart)
    .lte("created_at", weekEnd)

  const { data: priorWeek } = await svc
    .from("ai_message_drafts")
    .select("status")
    .eq("agent_user_id", agentUserId)
    .gte("created_at", priorWeekStart)
    .lt("created_at", weekStart)

  const acceptedStatuses = new Set(["accepted", "sent", "edited"])
  const tw = thisWeek ?? []
  const pw = priorWeek ?? []
  if (tw.length === 0 && pw.length === 0) return null

  const twAccepted = tw.filter((d: any) => acceptedStatuses.has(d.status)).length
  const pwAccepted = pw.filter((d: any) => acceptedStatuses.has(d.status)).length
  const twRate = tw.length > 0 ? (twAccepted / tw.length) * 100 : 0
  const pwRate = pw.length > 0 ? (pwAccepted / pw.length) * 100 : 0
  const delta = twRate - pwRate
  const deltaPct = pwRate > 0 ? (delta / pwRate) * 100 : null

  return {
    key: "reply_coach_acceptance",
    label: "Reply Coach acceptance",
    thisWeek: round1(twRate),
    priorWeek: round1(pwRate),
    delta: round1(delta),
    deltaPercent: deltaPct == null ? null : round1(deltaPct),
    trend: classifyTrend(delta),
    unit: "percent",
    insight: tw.length === 0
      ? "No AI drafts this week — try the Reply Coach next time you reply"
      : delta > 0
      ? `You accepted ${Math.round(twRate)}% of AI drafts (up from ${Math.round(pwRate)}%)`
      : delta < 0
      ? `You accepted ${Math.round(twRate)}% of AI drafts (down from ${Math.round(pwRate)}%)`
      : `You accepted ${Math.round(twRate)}% of AI drafts (flat)`,
  }
}

async function getIsaAppointmentsMetric(
  svc: ReturnType<typeof createServiceClient>,
  agentId: string,
  weekStart: string, priorWeekStart: string, weekEnd: string
): Promise<SmarterMetric | null> {
  // Resolve contacts owned by this agent (ai_isa_calls links via contact, not agent)
  const { data: contacts } = await svc
    .from("contacts")
    .select("id")
    .eq("agent_id", agentId)
  const contactIds = (contacts ?? []).map((c: any) => c.id)
  if (contactIds.length === 0) return null

  const { data: thisWeek } = await svc
    .from("ai_isa_calls")
    .select("appointment_set")
    .in("contact_id", contactIds)
    .gte("created_at", weekStart)
    .lte("created_at", weekEnd)

  const { data: priorWeek } = await svc
    .from("ai_isa_calls")
    .select("appointment_set")
    .in("contact_id", contactIds)
    .gte("created_at", priorWeekStart)
    .lt("created_at", weekStart)

  const tw = (thisWeek ?? []).filter((c: any) => c.appointment_set === true).length
  const pw = (priorWeek ?? []).filter((c: any) => c.appointment_set === true).length
  const delta = tw - pw
  const deltaPct = pw > 0 ? (delta / pw) * 100 : null

  if (tw === 0 && pw === 0) return null

  return {
    key: "isa_appointments_set",
    label: "Appointments AI booked for you",
    thisWeek: tw,
    priorWeek: pw,
    delta,
    deltaPercent: deltaPct == null ? null : round1(deltaPct),
    trend: classifyTrend(delta),
    unit: "count",
    insight: delta > 0
      ? `AI ISA booked ${tw} appointment${tw === 1 ? "" : "s"} this week — ${delta} more than last week`
      : `AI ISA booked ${tw} appointment${tw === 1 ? "" : "s"} this week`,
  }
}

async function getMatchQualityMetric(
  svc: ReturnType<typeof createServiceClient>,
  agentId: string,
  weekStart: string, priorWeekStart: string, weekEnd: string
): Promise<SmarterMetric | null> {
  // Resolve contacts owned by this agent
  const { data: contacts } = await svc
    .from("contacts")
    .select("id")
    .eq("agent_id", agentId)
  const contactIds = (contacts ?? []).map((c: any) => c.id)
  if (contactIds.length === 0) return null

  const { data: thisWeek } = await svc
    .from("property_matches")
    .select("match_score, user_feedback")
    .in("contact_id", contactIds)
    .gte("created_at", weekStart)
    .lte("created_at", weekEnd)

  const { data: priorWeek } = await svc
    .from("property_matches")
    .select("match_score, user_feedback")
    .in("contact_id", contactIds)
    .gte("created_at", priorWeekStart)
    .lt("created_at", weekStart)

  const tw = thisWeek ?? []
  const pw = priorWeek ?? []
  if (tw.length === 0 && pw.length === 0) return null

  const twAvg = avg(tw.map((m: any) => Number(m.match_score) || 0))
  const pwAvg = avg(pw.map((m: any) => Number(m.match_score) || 0))
  const delta = twAvg - pwAvg
  const deltaPct = pwAvg > 0 ? (delta / pwAvg) * 100 : null

  return {
    key: "property_match_quality",
    label: "Property match quality",
    thisWeek: round1(twAvg),
    priorWeek: round1(pwAvg),
    delta: round1(delta),
    deltaPercent: deltaPct == null ? null : round1(deltaPct),
    trend: classifyTrend(delta),
    unit: "score",
    insight: tw.length === 0
      ? "No new property matches generated this week"
      : `${tw.length} new matches, average score ${round1(twAvg)}/100`,
  }
}

async function getPracticeScoreMetric(
  svc: ReturnType<typeof createServiceClient>,
  agentUserId: string,
  weekStart: string, priorWeekStart: string, weekEnd: string
): Promise<SmarterMetric | null> {
  const { data: thisWeek } = await svc
    .from("objection_training_sessions")
    .select("total_score")
    .eq("agent_user_id", agentUserId)
    .eq("status", "completed")
    .gte("completed_at", weekStart)
    .lte("completed_at", weekEnd)

  const { data: priorWeek } = await svc
    .from("objection_training_sessions")
    .select("total_score")
    .eq("agent_user_id", agentUserId)
    .eq("status", "completed")
    .gte("completed_at", priorWeekStart)
    .lt("completed_at", weekStart)

  const tw = thisWeek ?? []
  const pw = priorWeek ?? []
  if (tw.length === 0 && pw.length === 0) return null

  const twAvg = avg(tw.map((s: any) => Number(s.total_score) || 0))
  const pwAvg = avg(pw.map((s: any) => Number(s.total_score) || 0))
  const delta = twAvg - pwAvg
  const deltaPct = pwAvg > 0 ? (delta / pwAvg) * 100 : null

  return {
    key: "objection_practice_score",
    label: "Objection practice score",
    thisWeek: round1(twAvg),
    priorWeek: round1(pwAvg),
    delta: round1(delta),
    deltaPercent: deltaPct == null ? null : round1(deltaPct),
    trend: classifyTrend(delta),
    unit: "score",
    insight: tw.length === 0
      ? "No practice sessions this week — try a scenario in Coaching → Objection Practice"
      : delta > 0
      ? `Average ${round1(twAvg)}/100 across ${tw.length} session${tw.length === 1 ? "" : "s"} — up ${round1(delta)} pts`
      : `Average ${round1(twAvg)}/100 across ${tw.length} session${tw.length === 1 ? "" : "s"}`,
  }
}

async function getCoachingInsightsMetric(
  svc: ReturnType<typeof createServiceClient>,
  agentId: string,
  weekStart: string, priorWeekStart: string, weekEnd: string
): Promise<SmarterMetric | null> {
  const { count: tw } = await svc
    .from("call_coaching_insights")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .gte("created_at", weekStart)
    .lte("created_at", weekEnd)

  const { count: pw } = await svc
    .from("call_coaching_insights")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .gte("created_at", priorWeekStart)
    .lt("created_at", weekStart)

  const thisWeek = tw ?? 0
  const priorWeek = pw ?? 0
  if (thisWeek === 0 && priorWeek === 0) return null

  const delta = thisWeek - priorWeek
  const deltaPct = priorWeek > 0 ? (delta / priorWeek) * 100 : null

  return {
    key: "call_coaching_insights",
    label: "Call coaching insights",
    thisWeek,
    priorWeek,
    delta,
    deltaPercent: deltaPct == null ? null : round1(deltaPct),
    trend: classifyTrend(delta),
    unit: "count",
    insight: thisWeek === 0
      ? "No new call coaching insights this week"
      : `${thisWeek} actionable insight${thisWeek === 1 ? "" : "s"} from your calls this week`,
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function classifyTrend(delta: number): "up" | "down" | "flat" {
  if (delta > 0.5) return "up"
  if (delta < -0.5) return "down"
  return "flat"
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((s, n) => s + n, 0) / nums.length
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function pickHighlight(metrics: SmarterMetric[]): string | null {
  const positive = metrics.filter((m) => m.trend === "up" && (m.deltaPercent ?? 0) > 5)
  if (positive.length === 0) return null
  const top = positive.sort((a, b) => (b.deltaPercent ?? 0) - (a.deltaPercent ?? 0))[0]
  return top.insight
}
