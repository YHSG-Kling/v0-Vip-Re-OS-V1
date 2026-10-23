"use server"

/**
 * app/actions/usage-overview.ts
 *
 * Loads the brokerage's monthly usage rollup + plan limits + top consumers
 * for the broker-visible /dashboard/settings/usage page.
 */

import { resolveActingContext } from "@/lib/platform/acting-context"
import { currentUsagePeriod } from "@/lib/usage/period"
import { createServiceClient } from "@/lib/supabase/service"
import { toPlanTier } from "@/lib/billing/plan-tier"
import { METRIC_LABELS, LIVE_STOCK_METRICS, COUNTER_BACKED_METRICS } from "@/lib/usage/metric-labels"
import { resolveSeatUsage } from "@/lib/kernel/seat-usage"
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"

export interface MetricSnapshot {
  metric: string
  label: string
  used: number
  limit: number
  percent: number
  unlimited: boolean
  /** UI tone — green / amber / red */
  status: "ok" | "warning" | "exceeded"
  /**
   * Where `used` comes from. "counter" = a usage_counters row some writer increments; "live" = counted
   * from the tenant's own rows when this was read (a STOCK, not a flow); "unmeasured" = nothing measures
   * this metric yet — `used` is 0 BECAUSE NOTHING COUNTED, not because nothing was used, and the UI must
   * say "Not measured yet" instead of drawing a green 0%.
   */
  source: "counter" | "live" | "unmeasured"
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

// TOMBSTONE (orphan doctrine §1.1, wave 143J): the private METRIC_LABELS table that stood here
// moved to lib/usage/metric-labels.ts:METRIC_LABELS — this is a "use server" module (every export is
// a public endpoint, async only), so three other surfaces that talk about the same plan limits could
// not import it and each invented its own numbers (see that file's header). It also carried FOURTEEN of
// the seventeen live metrics; the survivor carries all seventeen (ai_tokens_monthly and the two
// live_assistant_* metrics printed as their raw column names on this page).

// TRUE ADMIN GATE (operational usage view, team_lead already included) —
// repointed to the ONE tenant roster (isAdminOrBroker below). 'superadmin' was
// dead: 0 live rows store that users.user_type.
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export async function loadUsageOverview(): Promise<{
  ok: boolean
  data?: UsageOverview
  error?: string
}> {
  const ctx = await resolveActingContext()
  // FAIL CLOSED on a tenantless session (§4). The retired lib/kernel/identity.ts handed
  // this surface "the first brokerage ordered by created_at" when the session had none,
  // so a seat with no tenant read ANOTHER brokerage's meter. Refusing is the correct
  // answer — and without it every query below runs `.eq(…, null)`, which resolves as
  // zero rows with `error: null` and reports an empty invoice as a real one.
  if (!ctx.ok || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
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
  // 'starter' is the RETIRED vocabulary (scripts/1023-align-plan-tier-vocabulary.sql
  // mapped starter → solo_agent). `plan_limits` holds exactly the four canonical
  // tiers — MEASURED live: solo_agent / team / brokerage / multi_location, 17
  // metrics each and no 'starter' row — so a NULL plan_tier fell back to a value
  // the limits join can never match, and the meter rendered every metric with no
  // limit at all. toPlanTier is the ONE normalizer (§6) and it falls to the
  // TIGHTEST tier, which is the direction lib/billing/plan-tier.ts documents.
  const planTier = toPlanTier(brokerage?.plan_tier)

  // 2. Counters + limits — pull both, join in memory
  const [{ data: counters, error: countersError }, { data: limits, error: limitsError }] = await Promise.all([
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

  // A refused read RESOLVES (CLAUDE.md §3): without these two reads an unreadable counter table rendered
  // as "nothing used, no limits" — a clean, green, empty meter. Refuse out loud instead.
  if (countersError || limitsError) {
    return { ok: false, error: "Usage could not be read right now. Please try again." }
  }

  const usedByMetric = new Map<string, number>()
  for (const c of counters ?? []) {
    usedByMetric.set(c.metric, Number(c.value ?? 0))
  }

  // STOCK metrics are not flows — nothing increments them — so they are counted LIVE from the tenant's
  // own rows, scoped by the SESSION's brokerage (never a parameter). Before this, contacts_count,
  // active_transactions and active_users had no usage_counters writer anywhere, so every tenant saw
  // "0 / 500 contacts" however many they held. A count that cannot be read leaves the metric
  // UNMEASURED ("Not measured yet"), never zero.
  const liveUsed = new Map<string, number>()
  const wanted = new Set((limits ?? []).map((l) => l.metric))
  if (wanted.has("contacts_count")) {
    const { count, error } = await supabase.from("contacts").select("id", { count: "exact", head: true }).eq("brokerage_id", ctx.brokerageId)
    if (!error && count !== null) liveUsed.set("contacts_count", count)
  }
  if (wanted.has("active_transactions")) {
    const { count, error } = await supabase
      .from("transactions").select("id", { count: "exact", head: true })
      .eq("brokerage_id", ctx.brokerageId).in("status", [...TRANSACTION_STATUSES_OPEN])
    if (!error && count !== null) liveUsed.set("active_transactions", count)
  }
  if (wanted.has("active_users")) {
    // THE SEAT GATE'S OWN COUNT (lib/kernel/seat-usage.ts) — licensed producers, never "everyone with a login".
    const seats = await resolveSeatUsage(supabase, ctx.brokerageId)
    if (seats.ok) liveUsed.set("active_users", seats.seatCount)
  }

  const metrics: MetricSnapshot[] = (limits ?? []).map((l) => {
    const source: MetricSnapshot["source"] = LIVE_STOCK_METRICS.has(l.metric)
      ? (liveUsed.has(l.metric) ? "live" : "unmeasured")
      : (COUNTER_BACKED_METRICS.has(l.metric) || usedByMetric.has(l.metric) ? "counter" : "unmeasured")
    const used = source === "live" ? (liveUsed.get(l.metric) ?? 0) : source === "counter" ? (usedByMetric.get(l.metric) ?? 0) : 0
    const limit = Number(l.limit_value ?? -1)
    const unlimited = limit < 0
    const percent = !unlimited && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
    const softThresh = Number(l.soft_limit_threshold ?? 0.8) * 100
    const status: MetricSnapshot["status"] =
      unlimited || source === "unmeasured" ? "ok" :
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
      source,
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
