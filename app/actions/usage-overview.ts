"use server"

/**
 * app/actions/usage-overview.ts
 *
 * Loads the brokerage's monthly usage rollup + plan limits + top consumers
 * for the broker-visible /dashboard/settings/usage page.
 */

import { resolveWriteContext } from "@/lib/kernel/identity"
import { currentUsagePeriod } from "@/lib/usage/period"
import { createServiceClient } from "@/lib/supabase/service"

export interface MetricSnapshot {
  metric: string
  label: string
  used: number
  limit: number
  percent: number
  unlimited: boolean
  /** UI tone — green / amber / red */
  status: "ok" | "warning" | "exceeded"
}

export interface TopConsumer {
  agentId: string | null
  agentName: string | null
  metric: string
  total: number
}

export interface UsageOverview {
  brokerageId: string
  planTier: string
  periodStart: string
  periodEnd: string
  metrics: MetricSnapshot[]
  topConsumers: TopConsumer[]
}

const METRIC_LABELS: Record<string, string> = {
  llm_calls: "AI requests",
  video_minutes: "Video generation",
  active_users: "Active users",
  contacts_count: "Contacts",
  active_transactions: "Active transactions",
  sms_sent: "SMS sent",
  emails_sent: "Emails sent",
  storage_gb: "Storage (GB)",
  live_avatar_minutes: "Live AI minutes",
  live_avatar_sessions: "Live AI sessions",
  tts_characters: "Voice synthesis (chars)",
  voice_clones_created: "Twin voices created",
  avatars_created: "Twin avatars created",
  ai_voice_minutes: "AI calling (min)",
}

// TRUE ADMIN GATE (operational usage view, team_lead already included) —
// repointed to the ONE tenant roster (isAdminOrBroker below). 'superadmin' was
// dead: 0 live rows store that users.user_type.
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export async function loadUsageOverview(): Promise<{
  ok: boolean
  data?: UsageOverview
  error?: string
}> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!isAdminOrBroker({ user_type: ctx.userType })) return { ok: false, error: "Forbidden" }

  const supabase = createServiceClient()
  const now = new Date()
  // Canonical UTC period — lib/usage/period.ts (#190).
  const { periodStartIso: _ps, periodEndIso: _pe } = currentUsagePeriod(now)
  const periodStart = new Date(_ps)
  const periodEnd = new Date(_pe)

  // 1. Plan tier
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("plan_tier")
    .eq("id", ctx.brokerageId)
    .maybeSingle()
  const planTier = brokerage?.plan_tier ?? "starter"

  // 2. Counters + limits — pull both, join in memory
  const [{ data: counters }, { data: limits }] = await Promise.all([
    // READERS FILTER ON period_start ALONE — lib/usage/period.ts states the rule
    // verbatim: "the start identifies the month, and keying reads on the end is
    // how the old rows became unreachable". period_end is part of the row's
    // IDENTITY (UNIQUE brokerage_id, period_start, period_end, metric), so a
    // reader that pins it can only ever match rows written under the exact same
    // end convention — which is precisely the join that read zero AI tokens
    // forever before m474. Carried here from lib/usage.ts:135 (checkLimit),
    // which held the correct key and whose orphaned siblings were removed in the
    // lane-E burn-down; the survivor must not inherit the defect the duplicate
    // had already fixed.
    supabase
      .from("usage_counters")
      .select("metric, value")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("period_start", periodStart.toISOString()),
    supabase
      .from("plan_limits")
      .select("metric, limit_value, soft_limit_threshold")
      .eq("plan_tier", planTier),
  ])

  const usedByMetric = new Map<string, number>()
  for (const c of counters ?? []) {
    usedByMetric.set(c.metric, Number(c.value ?? 0))
  }

  const metrics: MetricSnapshot[] = (limits ?? []).map((l) => {
    const used = usedByMetric.get(l.metric) ?? 0
    const limit = Number(l.limit_value ?? -1)
    const unlimited = limit < 0
    const percent = !unlimited && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
    const softThresh = Number(l.soft_limit_threshold ?? 0.8) * 100
    const status: MetricSnapshot["status"] =
      unlimited ? "ok" :
        percent >= 100 ? "exceeded" :
          percent >= softThresh ? "warning" : "ok"
    return {
      metric: l.metric,
      label: METRIC_LABELS[l.metric] ?? l.metric,
      used,
      limit,
      percent,
      unlimited,
      status,
    }
  })

  // Sort: exceeded first, then warning, then by % desc within each
  metrics.sort((a, b) => {
    const order = { exceeded: 0, warning: 1, ok: 2 } as const
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status]
    return b.percent - a.percent
  })

  // 3. Top 5 consumers across the new media metrics this month
  const { data: events } = await supabase
    .from("usage_events")
    .select("agent_id, metric, quantity")
    .eq("brokerage_id", ctx.brokerageId)
    .gte("created_at", periodStart.toISOString())
    .lt("created_at", periodEnd.toISOString())
    .in("metric", [
      "live_avatar_minutes", "live_avatar_sessions", "tts_characters",
      "voice_clones_created", "avatars_created", "ai_voice_minutes",
    ])

  // Aggregate per (agent_id, metric)
  const agg = new Map<string, { agentId: string | null; metric: string; total: number }>()
  for (const e of events ?? []) {
    const key = `${e.agent_id ?? "—"}|${e.metric}`
    const cur = agg.get(key)
    if (cur) cur.total += Number(e.quantity ?? 0)
    else agg.set(key, { agentId: e.agent_id ?? null, metric: e.metric, total: Number(e.quantity ?? 0) })
  }

  const sorted = Array.from(agg.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)

  // Resolve agent names for the top entries
  const agentIds = sorted.map((s) => s.agentId).filter(Boolean) as string[]
  const nameByAgent = new Map<string, string>()
  if (agentIds.length) {
    const { data: agents } = await supabase
      .from("agents")
      .select("id, users(first_name, last_name)")
      .in("id", agentIds)
    for (const a of agents ?? []) {
      const composed = [(a.users as any)?.first_name, (a.users as any)?.last_name].filter(Boolean).join(" ")
      nameByAgent.set(a.id, composed || "Agent")
    }
  }

  const topConsumers: TopConsumer[] = sorted.map((s) => ({
    agentId: s.agentId,
    agentName: s.agentId ? nameByAgent.get(s.agentId) ?? null : null,
    metric: s.metric,
    total: Math.round(s.total),
  }))

  return {
    ok: true,
    data: {
      brokerageId: ctx.brokerageId,
      planTier,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      metrics,
      topConsumers,
    },
  }
}
