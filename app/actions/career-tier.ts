"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { gatherTierStats, tierProgress, TIER_GATES, TIER_ORDER, type CareerTier, type TierProgress } from "@/lib/recruiting/career-tier"

export interface AgentCareerProgress {
  current: CareerTier
  currentLabel: string
  ladder: Array<{ tier: CareerTier; label: string; reached: boolean; requiresApproval: boolean }>
  progress: TierProgress
  nextLabel: string | null
  nextRequiresApproval: boolean
}

/** Load an agent's career tier + progress (real production/tenure/team stats). Read-only. */
export async function getAgentCareerProgress(agentId: string): Promise<AgentCareerProgress | null> {
  if (!agentId) return null
  const svc = createServiceClient()
  const { data: agent } = await svc.from("agents").select("id, created_at, team_id, career_tier").eq("id", agentId).maybeSingle()
  if (!agent) return null
  const a = agent as any
  const current = (a.career_tier ?? "rookie") as CareerTier
  const stats = await gatherTierStats(svc, a, new Date())
  const progress = tierProgress(current, stats)
  return {
    current,
    currentLabel: TIER_GATES[current].label,
    ladder: TIER_ORDER.map((t) => ({ tier: t, label: TIER_GATES[t].label, reached: TIER_ORDER.indexOf(t) <= TIER_ORDER.indexOf(current), requiresApproval: TIER_GATES[t].requiresApproval })),
    progress,
    nextLabel: progress.nextTier ? TIER_GATES[progress.nextTier].label : null,
    nextRequiresApproval: progress.nextTier ? TIER_GATES[progress.nextTier].requiresApproval : false,
  }
}
