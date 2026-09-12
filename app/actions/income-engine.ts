"use server"

/**
 * Income Truth + Action Engine — server actions.
 *
 * computeAndPersistGapAction:
 *   Called nightly (cron) or on-demand from the dashboard. Runs analyzeIncomeGap
 *   + recommendActionsForAgent, writes one income_forecast_gap_analysis row
 *   per (agent, date) tuple (UNIQUE), and N income_gap_recommended_actions
 *   rows tied to it. Returns the persisted snapshot for inline UI rendering.
 *
 * getLatestGapAction:
 *   Read-only fetch for the dashboard. Returns most-recent snapshot + its
 *   open actions, scoped to the calling agent.
 *
 * dismissRecommendedActionAction:
 *   Agent dismisses a recommendation. Records outcome for future tuning.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { analyzeIncomeGap } from "@/lib/income-engine/gap-analyzer"
import { recommendActionsForAgent, type RecommendedAction } from "@/lib/income-engine/action-recommender"
import { isPlatformSuperadminIdentity } from "@/lib/platform/platform-staff-roster"

async function resolveAgentContext(): Promise<
  | { ok: true; userId: string; agentId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .eq("brokerage_id", profile.brokerage_id)
    .maybeSingle()
  if (!agent?.id) return { ok: false, error: "No agent record — this feature is agent-scoped" }
  return { ok: true, userId: user.id, agentId: agent.id, brokerageId: profile.brokerage_id }
}

// ── COMPUTE + PERSIST ───────────────────────────────────────────────────────

export interface GapAnalysisPersistResult {
  gap_analysis_id:          string
  weighted_30_cents:        number
  weighted_90_cents:        number
  weighted_180_cents:       number
  ytd_gci_cents:            number
  annual_goal_cents:        number | null
  projected_year_end_cents: number
  gap_to_goal_cents:        number | null
  gap_to_goal_pct:          number | null
  actions:                  RecommendedAction[]
}

/**
 * Compute the gap + actions for the calling agent (or the explicit agentId
 * when called by a cron / superadmin path) and persist.
 *
 * Idempotent: UNIQUE (agent_id, analysis_date) means re-running on the same
 * day updates the existing snapshot rather than creating a duplicate. Old
 * recommended_actions for that snapshot are cleared and re-inserted so the
 * ranking always reflects the current pipeline.
 */
export async function computeAndPersistGapAction(params?: {
  agentId?:     string  // superadmin override (still requires auth)
  brokerageId?: string  // superadmin override (still requires auth)
}): Promise<
  | { ok: true; result: GapAnalysisPersistResult }
  | { ok: false; error: string }
> {
  // CRITICAL: previous override path accepted caller-supplied agentId +
  // brokerageId with no auth check, letting any caller compute + persist
  // gap analysis on any agent's income forecast (data poisoning +
  // potentially overwriting another agent's recommended_actions).
  // Always resolve the calling session first.
  const ctx = await resolveAgentContext()
  if (!ctx.ok) return ctx

  let agentId:     string = ctx.agentId
  let brokerageId: string = ctx.brokerageId

  // Honor override only for superadmin AND only when both ids are passed.
  if (params?.agentId && params?.brokerageId) {
    const supabase = await createClient()
    const { data: profile } = await supabase
      .from("users").select("user_type, platform_role").eq("id", ctx.userId).maybeSingle()
    // PLATFORM GATE: mirrors requirePlatformSuperadmin (lib/kernel/api-auth.ts).
    // The old ["superadmin","super_admin"] user_type test admitted NOBODY — 0 live
    // rows store either spelling; the platform's one superadmin is
    // (user_type='admin', platform_role='superadmin'), so the override this gate
    // exists to allow was unreachable. Dual-column check fixes that; 'super_admin'
    // is dropped (not a storable user_type at all).
    // ONE DEFINITION (ruling 1, 2026-08-24) — survivor:
    // lib/platform/platform-staff-roster.ts:isPlatformSuperadminIdentity.
    if (!isPlatformSuperadminIdentity(profile?.user_type, (profile as any)?.platform_role)) {
      return { ok: false, error: "Forbidden: only superadmin may override agentId/brokerageId" }
    }
    agentId     = params.agentId
    brokerageId = params.brokerageId
  }

  // Resolve userId for the agent — income_forecast_snapshots.agent_id FKs users(id)
  const svc0 = createServiceClient()
  const { data: agentRow } = await svc0.from("agents").select("user_id").eq("id", agentId).maybeSingle()
  const userId = agentRow?.user_id as string | undefined
  if (!userId) return { ok: false, error: "Agent has no linked user_id" }

  // 1. Analyze the gap
  const gap = await analyzeIncomeGap({ agentId, userId, brokerageId })

  // 2. Generate ranked actions
  // BOTH ids: contacts/transactions/listings key on agents.id, while the
  // lifetime NPV ledger keys on users.id. Passing only agentId made the
  // sphere-nurture rule filter a users.id column with an agents.id and
  // silently return nothing.
  const actions = await recommendActionsForAgent({ agentId, agentUserId: userId, brokerageId, gap, maxActions: 5 })

  // 3. Persist (upsert by (agent_id, analysis_date))
  const svc = createServiceClient()
  const { data: persisted, error: upsertErr } = await svc
    .from("income_forecast_gap_analysis")
    .upsert({
      brokerage_id:             brokerageId,
      agent_id:                 agentId,
      forecast_snapshot_id:     gap.forecast_snapshot_id,
      weighted_30_cents:        gap.weighted_30_cents,
      weighted_90_cents:        gap.weighted_90_cents,
      weighted_180_cents:       gap.weighted_180_cents,
      ytd_gci_cents:            gap.ytd_gci_cents,
      annual_goal_cents:        gap.annual_goal_cents,
      remaining_year_cents:     gap.remaining_year_cents,
      projected_year_end_cents: gap.projected_year_end_cents,
      gap_to_goal_cents:        gap.gap_to_goal_cents,
      gap_to_goal_pct:          gap.gap_to_goal_pct,
      low_band_pct:             gap.low_band_pct,
      high_band_pct:            gap.high_band_pct,
      diagnostics:              gap.diagnostics,
      analysis_date:            new Date().toISOString().slice(0, 10),
      computed_at:              new Date().toISOString(),
    }, { onConflict: "agent_id,analysis_date" })
    .select("id")
    .single()

  if (upsertErr || !persisted) {
    return { ok: false, error: upsertErr?.message ?? "Failed to persist gap analysis" }
  }

  // 4. Clear old actions for THIS snapshot (re-running replaces, doesn't append)
  await svc.from("income_gap_recommended_actions")
    .delete()
    .eq("gap_analysis_id", persisted.id)

  // 5. Insert ranked actions
  if (actions.length > 0) {
    const { error: insertErr } = await svc
      .from("income_gap_recommended_actions")
      .insert(actions.map(a => ({
        gap_analysis_id:            persisted.id,
        agent_id:                   agentId,
        brokerage_id:               brokerageId,
        action_rank:                a.action_rank,
        action_category:            a.action_category,
        action_title:               a.action_title,
        action_description:         a.action_description,
        contact_id:                 a.contact_id,
        transaction_id:             a.transaction_id,
        listing_id:                 a.listing_id,
        estimated_gci_impact_cents: a.estimated_gci_impact_cents,
        estimated_effort_hours:     a.estimated_effort_hours,
        confidence_score:           a.confidence_score,
        impact_score:               a.impact_score,
        urgency_score:              a.urgency_score,
        priority_score:             a.priority_score,
        due_by:                     a.due_by,
        status:                     "open",
      })))
    if (insertErr) {
      return { ok: false, error: `Persisted gap but actions failed: ${insertErr.message}` }
    }
  }

  revalidatePath("/dashboard/income-truth")
  revalidatePath("/dashboard")

  return {
    ok: true,
    result: {
      gap_analysis_id:          persisted.id,
      weighted_30_cents:        gap.weighted_30_cents,
      weighted_90_cents:        gap.weighted_90_cents,
      weighted_180_cents:       gap.weighted_180_cents,
      ytd_gci_cents:            gap.ytd_gci_cents,
      annual_goal_cents:        gap.annual_goal_cents,
      projected_year_end_cents: gap.projected_year_end_cents,
      gap_to_goal_cents:        gap.gap_to_goal_cents,
      gap_to_goal_pct:          gap.gap_to_goal_pct,
      actions,
    },
  }
}

// ── READ ─────────────────────────────────────────────────────────────────────

export async function getLatestGapAction(): Promise<
  | { ok: true; snapshot: any; actions: any[] }
  | { ok: false; error: string }
> {
  const ctx = await resolveAgentContext()
  if (!ctx.ok) return ctx

  const svc = createServiceClient()
  const { data: snap, error: snapErr } = await svc
    .from("income_forecast_gap_analysis")
    .select("*")
    .eq("agent_id", ctx.agentId)
    .order("analysis_date", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (snapErr) return { ok: false, error: snapErr.message }
  if (!snap)   return { ok: true, snapshot: null, actions: [] }

  const { data: actions } = await svc
    .from("income_gap_recommended_actions")
    .select("*")
    .eq("gap_analysis_id", snap.id)
    .in("status", ["open", "in_progress"])
    .order("priority_score", { ascending: false })

  return { ok: true, snapshot: snap, actions: actions ?? [] }
}

// ── DISMISS / COMPLETE ──────────────────────────────────────────────────────

export async function dismissRecommendedActionAction(params: {
  actionId: string
  reason?:  string
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveAgentContext()
  if (!ctx.ok) return ctx
  const svc = createServiceClient()
  // `.select("id")` + a zero-row refusal (wave 4 slice 2). Without it an
  // actionId belonging to a DIFFERENT agent matched zero rows, came back with
  // error === null, and was reported as { ok: true } — the agent was told the
  // recommendation was dismissed when nothing was written, and it reappeared on
  // the next load with no explanation.
  const { data: touched, error } = await svc
    .from("income_gap_recommended_actions")
    .update({
      status:            "dismissed",
      completed_at:      new Date().toISOString(),
      completed_outcome: params.reason ?? "dismissed by agent",
    })
    .eq("id", params.actionId)
    .eq("agent_id", ctx.agentId)
    .select("id")
  if (error) return { ok: false, error: error.message }
  if (!touched || touched.length === 0) {
    return { ok: false, error: "That recommendation is not yours, or no longer exists." }
  }
  revalidatePath("/dashboard/income-truth")
  return { ok: true }
}

export async function completeRecommendedActionAction(params: {
  actionId: string
  outcome?: string
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveAgentContext()
  if (!ctx.ok) return ctx
  const svc = createServiceClient()
  // `.select("id")` + a zero-row refusal (wave 4 slice 2). Without it an
  // actionId belonging to a DIFFERENT agent matched zero rows, came back with
  // error === null, and was reported as { ok: true } — the agent was told the
  // recommendation was completed when nothing was written, and it reappeared on
  // the next load with no explanation.
  const { data: touched, error } = await svc
    .from("income_gap_recommended_actions")
    .update({
      status:            "completed",
      completed_at:      new Date().toISOString(),
      completed_outcome: params.outcome ?? null,
    })
    .eq("id", params.actionId)
    .eq("agent_id", ctx.agentId)
    .select("id")
  if (error) return { ok: false, error: error.message }
  if (!touched || touched.length === 0) {
    return { ok: false, error: "That recommendation is not yours, or no longer exists." }
  }
  revalidatePath("/dashboard/income-truth")
  return { ok: true }
}
