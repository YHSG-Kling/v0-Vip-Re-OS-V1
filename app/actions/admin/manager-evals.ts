"use server"

/**
 * app/actions/admin/manager-evals.ts
 *
 * The Manager Trust Scorecard. Anthropic Managed Agents grade every outcome-graded
 * session against a rubric; results land in agent_outcome_evaluations (written by
 * app/api/webhooks/anthropic-agent). That data was queryable via an admin API but
 * had ZERO UI — so the brokerage could never SEE how well its AI managers are
 * performing. This aggregates it per manager into a trust tier + recommended
 * autonomy posture: the certifiable-governance surface no competitor has.
 *
 * Read-only over existing tables (no migration). Admin-gated, brokerage-scoped
 * (platform staff see all brokerages).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import { scoreEvals, teamTrust, type ManagerEvalScore } from "@/lib/managers/eval-scoring"

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])

export interface ManagerTrustRow {
  agentKind: string
  label: string
  domain: string
  accent: string
  score: ManagerEvalScore
  sessionCount: number
  lastEvaluatedAt: string | null
  tokensIn: number
  tokensOut: number
}

export interface ManagerTrustScorecard {
  ok: true
  managers: ManagerTrustRow[]
  team: { passRate: number; total: number; trustedCount: number; managerCount: number }
}

export async function getManagerTrustScorecard(): Promise<
  ManagerTrustScorecard | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!ADMIN_ROLES.has(ctx.userType)) return { ok: false, error: "Forbidden" }

  const svc = createServiceClient()
  // Platform staff see all brokerages; everyone else is scoped to their own.
  const auth = await createClient()
  const { data: { user } } = await auth.auth.getUser()
  const { data: profile } = user
    ? await svc.from("users").select("platform_role").eq("id", user.id).maybeSingle()
    : { data: null }
  const isPlatform = ctx.userType === "superadmin" || isPlatformStaff(profile?.platform_role)
  if (!isPlatform && !ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }

  // 1) All graded outcomes (brokerage-scoped).
  let evalQ = svc
    .from("agent_outcome_evaluations")
    .select("managed_agent_session_id, result, input_tokens, output_tokens, evaluated_at")
    .order("evaluated_at", { ascending: false })
    .limit(5000)
  if (!isPlatform) evalQ = evalQ.eq("brokerage_id", ctx.brokerageId as string)
  const { data: evals, error } = await evalQ
  if (error) return { ok: false, error: error.message }

  // 2) session → managed_agent, and managed_agent → agent_kind.
  const sessionIds = Array.from(new Set((evals ?? []).map((e) => e.managed_agent_session_id as string).filter(Boolean)))
  const sessionToAgent = new Map<string, string>()
  if (sessionIds.length > 0) {
    const { data: sessions } = await svc.from("managed_agent_sessions").select("id, managed_agent_id").in("id", sessionIds)
    for (const s of sessions ?? []) sessionToAgent.set(s.id as string, s.managed_agent_id as string)
  }
  const agentIds = Array.from(new Set(Array.from(sessionToAgent.values()).filter(Boolean)))
  const agentToKind = new Map<string, string>()
  if (agentIds.length > 0) {
    const { data: agents } = await svc.from("managed_agents").select("id, agent_kind").in("id", agentIds)
    for (const a of agents ?? []) agentToKind.set(a.id as string, a.agent_kind as string)
  }

  // 3) Bucket evals by agent_kind.
  interface Bucket { evals: Array<{ result: string }>; sessions: Set<string>; lastAt: string | null; tokensIn: number; tokensOut: number }
  const buckets = new Map<string, Bucket>()
  for (const e of evals ?? []) {
    const sid = e.managed_agent_session_id as string
    const kind = agentToKind.get(sessionToAgent.get(sid) ?? "") ?? null
    if (!kind) continue
    const b = buckets.get(kind) ?? { evals: [], sessions: new Set(), lastAt: null, tokensIn: 0, tokensOut: 0 }
    b.evals.push({ result: e.result as string })
    b.sessions.add(sid)
    const at = e.evaluated_at as string | null
    if (at && (!b.lastAt || at > b.lastAt)) b.lastAt = at
    b.tokensIn += (e.input_tokens as number | null) ?? 0
    b.tokensOut += (e.output_tokens as number | null) ?? 0
    buckets.set(kind, b)
  }

  // 4) Render the FULL team (every registered manager), even those with no evals yet.
  const managers: ManagerTrustRow[] = (Object.keys(MANAGERS) as ManagerKey[])
    .map((kind) => {
      const info = MANAGERS[kind]
      const b = buckets.get(kind)
      return {
        agentKind: kind,
        label: info.label,
        domain: info.domain,
        accent: info.accent,
        score: scoreEvals(b?.evals ?? []),
        sessionCount: b?.sessions.size ?? 0,
        lastEvaluatedAt: b?.lastAt ?? null,
        tokensIn: b?.tokensIn ?? 0,
        tokensOut: b?.tokensOut ?? 0,
      }
    })
    .sort((a, b) => b.score.total - a.score.total || a.label.localeCompare(b.label))

  const team = teamTrust(managers.map((m) => m.score))
  return { ok: true, managers, team: { ...team, managerCount: managers.length } }
}
