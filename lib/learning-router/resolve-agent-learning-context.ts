/**
 * Resolve the agent-side learning context.
 *
 * Mirrors the customer-side resolveEducationContext (lib/portal/resolve-
 * education-context.ts) but for AGENTS. Outputs the signals the router
 * uses to pick the next-best learning_module for this agent:
 *
 *   - tenure (days since first agent_onboarding row)
 *   - completed module ids
 *   - performance gaps (which top-quartile patterns this agent isn't using,
 *     which Co-Pilots they miss, which surfaces have open interventions)
 *   - active certifications (so we don't re-assign already-cleared modules)
 *
 * The router (separate file) intersects these signals against
 * learning_modules.audience_roles + gap_tags + stage_tags and picks the
 * top N by display_priority.
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
// Client-agnostic resolver: this runs against the CALLER's client so the
// agents lookup stays RLS-scoped exactly like every other read in here.
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"

export interface AgentLearningContext {
  userId:              string
  brokerageId:         string
  tenureDays:          number | null
  completedModuleIds:  string[]
  /** Performance gap tags this agent currently exhibits. Used to match
   *  against learning_modules.gap_tags. Possible values are open-ended
   *  but the canonical set is documented in the migration: 'low_close_rate',
   *  'long_dom', 'missed_repair_copilot', 'no_sphere_touchpoints',
   *  'low_ai_isa_adoption', 'no_negotiation_copilot_use',
   *  'open_deal_interventions', 'open_listing_interventions'. */
  gapTags:             string[]
  /** Brokerage Intelligence insights this agent has NOT adopted —
   *  surface a learning module that teaches the pattern. */
  unadoptedInsightIds: string[]
}

export async function resolveAgentLearningContext(
  supabase: SupabaseClient,
  userId:   string,
): Promise<AgentLearningContext | null> {
  // Brokerage + tenure
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type, created_at")
    .eq("id", userId)
    .maybeSingle()
  if (!profile?.brokerage_id) return null
  if (profile.user_type !== "agent") return null   // this resolver is agents-only

  const brokerageId = profile.brokerage_id as string
  const tenureDays = profile.created_at
    ? Math.floor((Date.now() - new Date(profile.created_at as string).getTime()) / 86_400_000)
    : null

  // Completed modules
  const { data: completedRows } = await supabase
    .from("learning_assignments")
    .select("module_id")
    .eq("agent_user_id", userId)
    .eq("status", "completed")
  const completedModuleIds = (completedRows ?? [])
    .map((r: Record<string, unknown>) => (r as { module_id: string }).module_id)

  // ─── Performance gaps ────────────────────────────────────────────────
  const gapTags: string[] = []

  // 1. Open deal-health interventions on this agent's transactions?
  //    Brokerage is already known here, so use the SCOPED resolve — a user
  //    carrying agents rows in two brokerages must not be answered with the
  //    other tenant's row.
  const agentsId = await resolveAgentIdInBrokerage(supabase, userId, brokerageId)

  if (agentsId) {
    const { count: openDealIv } = await supabase
      .from("proactive_interventions")
      .select("id", { count: "exact", head: true })
      .eq("resolved", false)
      .eq("brokerage_id", brokerageId)
      .in(
        "transaction_id",
        await getAgentTransactionIds(supabase, agentsId, brokerageId),
      )
    if ((openDealIv ?? 0) >= 1) gapTags.push("open_deal_interventions")
  }

  // 2. Open listing-health interventions on this agent's listings?
  //    No agents row → no listings of their own → no gap to tag.
  if (agentsId) {
    const { count: openListingIv } = await supabase
      .from("listing_health_interventions")
      .select("id", { count: "exact", head: true })
      .eq("resolved", false)
      .eq("agent_id", agentsId)
      .eq("brokerage_id", brokerageId)
    if ((openListingIv ?? 0) >= 1) gapTags.push("open_listing_interventions")
  }

  // 3. NPV touchpoints overdue (>0)? Sphere neglect.
  const today = new Date().toISOString().slice(0, 10)
  const { count: overdueNpv } = await supabase
    .from("learning_assignments")
    .select("id", { count: "exact", head: true })   // self-ref placeholder
    .eq("brokerage_id", brokerageId)
    .limit(1)
  void overdueNpv  // we'll fold NPV-overdue into router instead of context

  // 4. Unadopted brokerage intelligence insights (top-quartile patterns
  //    this agent's peers use that this agent does NOT)
  const { data: openInsights } = await supabase
    .from("brokerage_intelligence_insights")
    .select("id, pattern_key, supporting_agents")
    .eq("status", "open")
    .eq("brokerage_id", brokerageId)
  const unadoptedInsightIds: string[] = []
  for (const ins of (openInsights ?? []) as Array<{ id: string; pattern_key: string; supporting_agents: string[] | null }>) {
    const supporters = ins.supporting_agents ?? []
    if (!supporters.includes(userId)) {
      unadoptedInsightIds.push(ins.id)
      // Map pattern_key → gap_tag so modules tagged with these gaps surface
      if (ins.pattern_key === "response_time")                gapTags.push("slow_lead_response")
      if (ins.pattern_key === "touchpoint_cadence")           gapTags.push("no_sphere_touchpoints")
      if (ins.pattern_key === "ai_isa_lift")                  gapTags.push("low_ai_isa_adoption")
      if (ins.pattern_key === "drip_engagement")              gapTags.push("low_drip_enrollment")
      if (ins.pattern_key === "negotiation_copilot_adoption") gapTags.push("no_negotiation_copilot_use")
    }
  }

  // 5. Income forecast snapshot — if weighted_30 is dramatically lower than
  //    peers, surface pipeline-management modules.
  // (Skipped for v1; the brokerage insights miner already captures this.)

  return {
    userId,
    brokerageId,
    tenureDays,
    completedModuleIds,
    gapTags:             Array.from(new Set(gapTags)),
    unadoptedInsightIds,
  }
}

async function getAgentTransactionIds(
  supabase:    SupabaseClient,
  agentsId:    string,
  brokerageId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("transactions")
    .select("id")
    .eq("agent_id", agentsId)
    .eq("brokerage_id", brokerageId)
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
}
