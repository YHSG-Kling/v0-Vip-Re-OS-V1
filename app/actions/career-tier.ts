"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import { gatherTierStats, tierProgress, TIER_GATES, TIER_ORDER, type CareerTier, type TierProgress } from "@/lib/recruiting/career-tier"

export interface AgentCareerProgress {
  current: CareerTier
  currentLabel: string
  ladder: Array<{ tier: CareerTier; label: string; reached: boolean; requiresApproval: boolean }>
  progress: TierProgress
  nextLabel: string | null
  nextRequiresApproval: boolean
}

/**
 * Session → identity. The same `requireCaller()` shape app/actions/video-generation.ts:57
 * carries (one copy per "use server" file — there is no shared lib helper yet).
 * Reads `{ data, error }` (§3).
 */
async function requireCaller(): Promise<
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: u, error } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (error) return { ok: false, error: `Could not resolve your profile: ${error.message}` }
  if (!u?.brokerage_id) return { ok: false, error: "Your account is not linked to a brokerage" }
  return { ok: true, supabase, userId: user.id, brokerageId: u.brokerage_id as string, userType: String(u.user_type ?? "") }
}

/**
 * Load an agent's career tier + progress (real production/tenure/team stats). Read-only.
 *
 * GATED ON THE SESSION (§4). This ran on the SERVICE client with `agentId` straight from
 * the parameter and no auth at all — any caller could read any agent's production and
 * tenure stats across every tenant. `agentId` is kept (the card passes the agent's own
 * id; an admin may look at a teammate) but it is now AUTHORISED, not trusted:
 *
 *   · the agent is the caller's OWN agent row (`agents.user_id` = session user — the
 *     agents.id / users.id spaces are disjoint, §3, so the cross is via user_id), OR
 *   · the agent is in the caller's brokerage AND the caller administers that tenant
 *     (resolveTenantAdmin — the ONE roster, isAdminOrBroker's user_type half plus the
 *     role-grant half, tenant-pinned).
 *
 * Anything that cannot be verified refuses (null). The agent row is read BEFORE the
 * verdict only to learn whose it is; no stat is computed until the gate answers.
 */
export async function getAgentCareerProgress(agentId: string): Promise<AgentCareerProgress | null> {
  if (!agentId) return null
  const caller = await requireCaller()
  if (!caller.ok) return null

  const svc = createServiceClient()
  const { data: agent, error } = await svc
    .from("agents")
    .select("id, created_at, team_id, career_tier, brokerage_id, user_id")
    .eq("id", agentId)
    .maybeSingle()
  if (error) {
    console.error("[career-tier] agent read refused:", error.message)
    return null
  }
  if (!agent) return null
  const a = agent as any

  const isOwn = a.user_id === caller.userId
  if (!isOwn) {
    if (a.brokerage_id !== caller.brokerageId) return null
    const admin = await resolveTenantAdmin(caller.supabase, caller.userId, {
      user_type: caller.userType,
      brokerage_id: caller.brokerageId,
    })
    if (!admin.ok || !admin.isTenantAdmin) return null
  }

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
