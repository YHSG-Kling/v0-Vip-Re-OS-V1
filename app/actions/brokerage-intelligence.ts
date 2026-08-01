"use server"

/**
 * Brokerage Intelligence Mesh — admin actions.
 *
 *   - getBrokerageInsights({ brokerageId })      — open insights for triage
 *   - adoptInsightAction({ insightId, agentIds }) — apply playbook to N agents
 *   - dismissInsightAction({ insightId, reason }) — broker dismisses pattern
 *   - rescanBrokerageIntelligenceAction({ brokerageId }) — admin on-demand
 *
 * The "adopt" path is the killer move. It translates each insight's
 * playbook_actions array into concrete writes against the live data layer:
 *
 *   - enable_ai_isa_on_new_leads / on_existing_leads → flip
 *     contacts.ai_isa_enabled per agent
 *   - first_touch_target_minutes → record on a per-agent setting (uses
 *     contacts.metadata via a brokerage-level setting in the future;
 *     for now the adoption is logged for analytics + the broker still
 *     gets visible "I told them" attribution)
 *   - enroll_in_drip_within_24h → no-op write today (sequence triggers
 *     are agent-driven via the Workflow Builder); we record the adoption
 *     and surface it to the agent's daily briefing.
 *   - set_sphere_cadence_days / enable_npv_due_alerts → recorded as
 *     adoption preferences in pattern_adoptions; the NPV-due alert is
 *     opt-in by checking pattern_adoptions when surfacing.
 *
 * Each adoption logs to pattern_adoptions for audit + future "actual lift
 * after adoption" follow-up scoring.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"

// ─── Types ────────────────────────────────────────────────────────────────

export interface BrokerageInsight {
  id:                    string
  patternKey:            string
  headline:              string
  metricLabel:           string
  topQuartileValue:      number | null
  medianValue:           number | null
  bottomQuartileValue:   number | null
  outcomeLabel:          string | null
  topQuartileOutcome:    number | null
  medianOutcome:         number | null
  bottomQuartileOutcome: number | null
  liftPct:               number
  sampleSize:            number
  supportingAgentCount:  number
  playbook:              string | null
  playbookActions:       Array<{ type: string; [k: string]: unknown }>
  severity:              "low" | "medium" | "high" | "critical"
  status:                "open" | "dismissed" | "superseded" | "expired"
  computedAt:            string
}

const ADMIN_USER_TYPES = new Set([
  "superadmin", "broker", "broker_admin", "admin", "team_lead",
])

async function requireAdmin(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: profile } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  const userType = (profile?.user_type as string | undefined) ?? ""
  if (!ADMIN_USER_TYPES.has(userType)) return { ok: false, error: "Insufficient privileges" }
  if (!profile?.brokerage_id) return { ok: false, error: "No brokerage" }
  return { ok: true, userId: user.id, brokerageId: profile.brokerage_id as string, userType }
}

// ─── Reads ────────────────────────────────────────────────────────────────

export async function getBrokerageInsights(params?: {
  status?: "open" | "dismissed" | "superseded" | "expired"
  limit?:  number
}): Promise<{ success: boolean; error?: string; insights?: BrokerageInsight[] }> {
  const auth = await requireAdmin()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()
  const status = params?.status ?? "open"
  const { data, error } = await supabase
    .from("brokerage_intelligence_insights")
    .select("id, pattern_key, headline, metric_label, top_quartile_value, median_value, bottom_quartile_value, outcome_label, top_quartile_outcome, median_outcome, bottom_quartile_outcome, lift_pct, sample_size, supporting_agent_count, playbook, playbook_actions, severity, status, computed_at")
    .eq("brokerage_id", auth.brokerageId)
    .eq("status", status)
    .order("lift_pct", { ascending: false })
    .limit(params?.limit ?? 20)

  if (error) return { success: false, error: error.message }

  return {
    success: true,
    insights: (data ?? []).map((r) => ({
      id:                    r.id as string,
      patternKey:            r.pattern_key as string,
      headline:              r.headline as string,
      metricLabel:           r.metric_label as string,
      topQuartileValue:      r.top_quartile_value == null ? null : Number(r.top_quartile_value),
      medianValue:           r.median_value == null ? null : Number(r.median_value),
      bottomQuartileValue:   r.bottom_quartile_value == null ? null : Number(r.bottom_quartile_value),
      outcomeLabel:          (r.outcome_label as string | null) ?? null,
      topQuartileOutcome:    r.top_quartile_outcome == null ? null : Number(r.top_quartile_outcome),
      medianOutcome:         r.median_outcome == null ? null : Number(r.median_outcome),
      bottomQuartileOutcome: r.bottom_quartile_outcome == null ? null : Number(r.bottom_quartile_outcome),
      liftPct:               Number(r.lift_pct),
      sampleSize:            Number(r.sample_size),
      supportingAgentCount:  Number(r.supporting_agent_count),
      playbook:              (r.playbook as string | null) ?? null,
      playbookActions:       (r.playbook_actions as Array<{ type: string; [k: string]: unknown }>) ?? [],
      severity:              r.severity as BrokerageInsight["severity"],
      status:                r.status as BrokerageInsight["status"],
      computedAt:            r.computed_at as string,
    })),
  }
}

// ─── Adopt ────────────────────────────────────────────────────────────────

export async function adoptInsightAction(params: {
  insightId: string
  /** Agent user_ids to push the playbook to. Empty array → all agents
   *  in the brokerage. */
  /** users.id values. `agentIds` is accepted as the pre-m350 name. */
  agentUserIds?: string[]
  agentIds?: string[]
}): Promise<{ success: boolean; error?: string; adopted?: number }> {
  if (!isValidUUID(params.insightId)) return { success: false, error: "Invalid insight id" }
  const auth = await requireAdmin()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()
  const svc = createServiceClient()

  // Load insight + verify it's in this brokerage
  const { data: insight } = await supabase
    .from("brokerage_intelligence_insights")
    .select("id, brokerage_id, playbook_actions, pattern_key")
    .eq("id", params.insightId)
    .maybeSingle()
  if (!insight) return { success: false, error: "Insight not found" }
  if (insight.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Insight is not in your brokerage" }
  }

  // Resolve target agent list — if empty, broadcast to all agents
  // NAMED agentUserIds, not agentIds (m350). These are `users.id` — the query
  // below reads the users table — and the distinction is load-bearing: the
  // pattern_adoptions write wants exactly this class, while the contacts update
  // in applyAction wants the OTHER one. Under the old name both looked right.
  let agentUserIds = (params.agentUserIds ?? params.agentIds ?? []).filter(Boolean)
  if (agentUserIds.length === 0) {
    const { data: allAgents } = await svc
      .from("users")
      .select("id")
      .eq("brokerage_id", auth.brokerageId)
      .eq("user_type", "agent")
    agentUserIds = ((allAgents ?? []) as Array<{ id: string }>).map((a) => a.id)
  }

  const actions = (insight.playbook_actions as Array<{ type: string; [k: string]: unknown }>) ?? []
  let appliedCount = 0

  for (const agentUserId of agentUserIds) {
    try {
      const applied: typeof actions = []
      for (const action of actions) {
        const ok = await applyAction({ svc, agentUserId, brokerageId: auth.brokerageId, action })
        if (ok) applied.push(action)
      }
      await svc.from("pattern_adoptions").insert({
        insight_id:       insight.id,
        brokerage_id:     auth.brokerageId,
        agent_user_id:    agentUserId,
        adopted_by:       auth.userId,
        applied_actions:  applied,
        status:           applied.length === actions.length ? "applied" : (applied.length === 0 ? "failed" : "applied"),
      })
      appliedCount += 1
    } catch (e) {
      console.error(`[adoptInsight] agent ${agentUserId}:`, e)
    }
  }

  revalidatePath("/dashboard/admin")
  return { success: true, adopted: appliedCount }
}

async function applyAction(input: {
  svc:         ReturnType<typeof createServiceClient>
  /** users.id — resolved to an agents id below for the contacts write. */
  agentUserId: string
  brokerageId: string
  action:      { type: string; [k: string]: unknown }
}): Promise<boolean> {
  const { svc, agentUserId, brokerageId, action } = input

  switch (action.type) {
    case "enable_ai_isa_on_new_leads":
    case "enable_ai_isa_on_existing_leads": {
      // Flip ai_isa_enabled=true on the agent's contacts where eligibility
      // is met (not dnc, not opted out). Bounded write to avoid surprise.
      const onlyExisting = action.type === "enable_ai_isa_on_existing_leads"
      // IDENTITY CLASS (m350, found by the rename). agentUserId is a users id —
      // adoptInsightAction reads the target list straight out of `users`. But
      // contacts.agent_id FKs AGENTS, so this update matched ZERO rows for every
      // agent, every time, and still returned true: the playbook reported
      // "applied" and no contact ever had ai_isa_enabled flipped. The two ids
      // sat in the same variable under the same name, which is the whole reason
      // the users-class columns are being renamed.
      const { data: agentRow } = await svc
        .from("agents").select("id").eq("user_id", agentUserId).eq("brokerage_id", brokerageId).maybeSingle()
      if (!agentRow?.id) return false
      let q = svc.from("contacts")
        .update({ ai_isa_enabled: true })
        .eq("brokerage_id", brokerageId)
        .eq("agent_id", agentRow.id)
        .neq("dnc_status", true)
        .neq("ai_outreach_paused", true)
        .neq("ai_isa_enabled", true)
      if (!onlyExisting) {
        // For "new leads" we still only flip current leads — net effect
        // is the same; future leads inherit the agent's default elsewhere
        // (a separate brokerage default flag is a v2 surface).
      }
      await q
      return true
    }
    case "first_touch_target_minutes":
    case "set_sphere_cadence_days":
    case "enable_npv_due_alerts":
    case "enroll_in_drip_within_24h": {
      // These are policy/playbook signals — recording the adoption is the
      // contract today; agent-side enforcement is handled by existing
      // surfaces (NPV panel due-this-week, Daily Briefing, etc.) reading
      // pattern_adoptions to know what to surface.
      return true
    }
    default:
      return false
  }
}

// ─── Dismiss ──────────────────────────────────────────────────────────────

export async function dismissInsightAction(params: {
  insightId: string
  reason?:   string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.insightId)) return { success: false, error: "Invalid insight id" }
  const auth = await requireAdmin()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()
  const { error } = await supabase
    .from("brokerage_intelligence_insights")
    .update({
      status:           "dismissed",
      dismissed_at:     new Date().toISOString(),
      dismissed_by:     auth.userId,
      dismissal_reason: params.reason ?? null,
    })
    .eq("id", params.insightId)
    .eq("brokerage_id", auth.brokerageId)
  if (error) return { success: false, error: error.message }

  revalidatePath("/dashboard/admin")
  return { success: true }
}

// ─── On-demand mine ───────────────────────────────────────────────────────

export async function rescanBrokerageIntelligenceAction(): Promise<{ success: boolean; error?: string; written?: number }> {
  const auth = await requireAdmin()
  if (!auth.ok) return { success: false, error: auth.error }

  const secret = process.env.CRON_SECRET
  if (!secret) return { success: false, error: "CRON_SECRET not configured" }
  const base = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL
  const url = base
    ? `${base.startsWith("http") ? base : `https://${base}`}/api/cron/brokerage-intelligence-mine`
    : "/api/cron/brokerage-intelligence-mine"

  try {
    const r = await fetch(url, {
      method:  "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body:    JSON.stringify({ brokerage_id: auth.brokerageId }),
      cache:   "no-store",
    })
    const data = await r.json().catch(() => null)
    if (!r.ok) return { success: false, error: data?.error ?? `Mining returned ${r.status}` }
    revalidatePath("/dashboard/admin")
    return { success: true, written: data?.insights_written ?? 0 }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Mining failed" }
  }
}
