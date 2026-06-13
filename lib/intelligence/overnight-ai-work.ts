// lib/intelligence/overnight-ai-work.ts
//
// "What the AI team did while you slept" — the daily brief's section for the NEWEST
// autonomous systems, so the agent SEES the overnight work and the items needing a human.
// Deterministic + honest (real rows only, never fabricated); mirrors isa-overnight.ts.
// Counts via head:true to stay cheap. Brokerage-scoped (reels) + agent-scoped where the
// row carries an agent.

import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface OvernightAiWorkSection {
  /** Appointments the no-show autopilot flagged for a gated re-book. */
  noshows_to_rebook: number
  /** Director reels staged + awaiting the agent's approval (Content Studio). */
  reels_awaiting_approval: number
  /** AI Sentinel license-risk escalations needing a human (unread). */
  sentinel_escalations: number
  /** One-line spoken summary; empty string when nothing happened overnight. */
  summary_line: string
}

/** Build the overnight-AI-work section for one agent. since = the lookback window
 *  (typically last 24h). Honest zeros + empty summary when nothing happened. */
export async function buildOvernightAiWork(
  supabase: Svc,
  input: { agentUserId: string; brokerageId: string; since: string },
): Promise<OvernightAiWorkSection> {
  const { agentUserId, brokerageId, since } = input

  const [noshow, reels, sentinel] = await Promise.all([
    supabase.from("calendar_events").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("status", "no_show").gte("start_at", since),
    supabase.from("ai_video_projects").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("approval_status", "pending_review").gte("created_at", since),
    supabase.from("notifications").select("id", { count: "exact", head: true })
      .eq("user_id", agentUserId).eq("is_read", false).ilike("type", "ai_sentinel%").gte("created_at", since),
  ])

  const noshows_to_rebook = noshow.count ?? 0
  const reels_awaiting_approval = reels.count ?? 0
  const sentinel_escalations = sentinel.count ?? 0

  const parts: string[] = []
  if (sentinel_escalations > 0) parts.push(`${sentinel_escalations} license-risk escalation${sentinel_escalations === 1 ? "" : "s"} need your eyes`)
  if (noshows_to_rebook > 0) parts.push(`${noshows_to_rebook} no-show${noshows_to_rebook === 1 ? "" : "s"} queued for re-book`)
  if (reels_awaiting_approval > 0) parts.push(`${reels_awaiting_approval} reel${reels_awaiting_approval === 1 ? "" : "s"} ready to approve`)

  return {
    noshows_to_rebook,
    reels_awaiting_approval,
    sentinel_escalations,
    summary_line: parts.length ? `Overnight: ${parts.join("; ")}.` : "",
  }
}
