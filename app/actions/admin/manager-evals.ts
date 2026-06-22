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
import { revalidatePath } from "next/cache"
import {
  scoreEvals, teamTrust, effectiveAutonomy, isAutonomyPosture,
  type ManagerEvalScore, type AutonomyPosture,
} from "@/lib/managers/eval-scoring"

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
  /** Broker-set policy override stored on managed_agents.config (null = follow recommendation). */
  overrideAutonomy: AutonomyPosture | null
  /** What the manager actually operates under = override ?? recommended. */
  effectiveAutonomy: AutonomyPosture
  /** Whether this manager has an instantiated managed_agents row (override is settable only then). */
  isActive: boolean
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

  // 3b) Per-kind autonomy override (broker policy of record) from managed_agents.config.
  //     Fetch ALL of the brokerage's managed agents so overrides show even for kinds with no evals.
  let agentRowQ = svc.from("managed_agents").select("agent_kind, config").is("archived_at", null)
  if (!isPlatform) agentRowQ = agentRowQ.eq("brokerage_id", ctx.brokerageId as string)
  const { data: agentRows } = await agentRowQ
  const overrideByKind = new Map<string, AutonomyPosture | null>()
  const activeKinds = new Set<string>()
  for (const a of agentRows ?? []) {
    const kind = a.agent_kind as string
    activeKinds.add(kind)
    const cfg = (a.config ?? {}) as Record<string, unknown>
    const ov = cfg.autonomy_tier
    if (isAutonomyPosture(ov)) overrideByKind.set(kind, ov)
  }

  // 4) Render the FULL team (every registered manager), even those with no evals yet.
  const managers: ManagerTrustRow[] = (Object.keys(MANAGERS) as ManagerKey[])
    .map((kind) => {
      const info = MANAGERS[kind]
      const b = buckets.get(kind)
      const score = scoreEvals(b?.evals ?? [])
      const override = overrideByKind.get(kind) ?? null
      return {
        agentKind: kind,
        label: info.label,
        domain: info.domain,
        accent: info.accent,
        score,
        sessionCount: b?.sessions.size ?? 0,
        lastEvaluatedAt: b?.lastAt ?? null,
        tokensIn: b?.tokensIn ?? 0,
        tokensOut: b?.tokensOut ?? 0,
        overrideAutonomy: override,
        effectiveAutonomy: effectiveAutonomy(score.autonomy, override),
        isActive: activeKinds.has(kind),
      }
    })
    .sort((a, b) => b.score.total - a.score.total || a.label.localeCompare(b.label))

  const team = teamTrust(managers.map((m) => m.score))
  return { ok: true, managers, team: { ...team, managerCount: managers.length } }
}

/**
 * Broker governance: set (or clear) a manager's autonomy posture override. Persisted
 * on managed_agents.config.autonomy_tier for every instantiated agent of that kind in
 * the brokerage — the policy of record an enforcement layer gates on. Pass null to
 * clear the override (manager reverts to its eval-derived recommendation).
 */
export async function setManagerAutonomy(
  agentKind: string,
  posture: AutonomyPosture | null,
): Promise<{ ok: true; updated: number } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  // Setting team operating policy is a broker/admin decision (not team_lead).
  if (!["broker", "broker_admin", "admin", "superadmin"].includes(ctx.userType)) {
    return { ok: false, error: "Forbidden — only a broker or admin can set manager autonomy policy" }
  }
  if (posture !== null && !isAutonomyPosture(posture)) return { ok: false, error: "Invalid autonomy posture" }
  if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }

  const svc = createServiceClient()
  const { data: rows, error: readErr } = await svc
    .from("managed_agents")
    .select("id, config")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("agent_kind", agentKind)
    .is("archived_at", null)
  if (readErr) return { ok: false, error: readErr.message }
  if (!rows || rows.length === 0) {
    return { ok: false, error: "This manager has no active session yet — autonomy policy applies once it runs." }
  }

  let updated = 0
  const nowIso = new Date().toISOString()
  for (const row of rows) {
    const cfg = { ...((row.config ?? {}) as Record<string, unknown>) }
    if (posture === null) { delete cfg.autonomy_tier; delete cfg.autonomy_updated_at; delete cfg.autonomy_set_by }
    else { cfg.autonomy_tier = posture; cfg.autonomy_updated_at = nowIso; cfg.autonomy_set_by = ctx.userId }
    const { error } = await svc.from("managed_agents").update({ config: cfg, updated_at: nowIso }).eq("id", row.id as string)
    if (!error) updated += 1
  }
  revalidatePath("/dashboard/admin/manager-trust")
  return { ok: true, updated }
}
