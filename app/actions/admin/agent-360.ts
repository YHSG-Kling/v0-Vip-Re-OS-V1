"use server"

/**
 * Agent 360 — the manager's full view of one agent, assembled from the rails
 * that already exist (keep-one, no new pipelines):
 *
 *   production   — agents denormalized YTD stats (updateAgentYTDStats maintains
 *                  ytd_gci / ytd_transactions / cap_progress / cap_amount)
 *                  + a live active-transactions count
 *   goals        — agent_goals for the current year (target vs current;
 *                  syncGoalCurrentValues keeps current_value fresh)
 *   payments     — commissions ledger (the payouts flow's table): paid rows are
 *                  the receipts, pending rows show what's owed. NOTE: a legacy
 *                  agent_commissions twin also exists (agent-facing YTD/CSV
 *                  readers) — consolidating the pair needs its own dependency
 *                  sweep; this view reads the payout-lifecycle table.
 *   gamification — agents.gamification_points + tier (same thresholds as
 *                  getAgentPointsAndTier), earned badges, recent points log
 *
 * Authorization mirrors agent-profile.ts: broker / broker_admin / admin /
 * superadmin / team_lead, and the target must be in the caller's brokerage.
 * The commission-agreement e-sign status renders via the existing
 * CommissionAgreementCard on the same page.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

const MANAGER_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])

export interface Agent360Goal {
  goalType: string
  targetValue: number
  currentValue: number
  year: number
}

export interface Agent360Payment {
  id: string
  status: string
  agentCommission: number
  grossCommission: number
  depositReceivedAt: string | null
  createdAt: string
}

export interface Agent360Badge {
  name: string
  icon: string | null
  tier: string | null
  awardedAt: string
}

export interface Agent360 {
  agentId: string
  production: {
    ytdGci: number
    ytdTransactions: number
    capProgress: number | null
    capAmount: number | null
    activeTransactions: number
  }
  goals: Agent360Goal[]
  payments: {
    paid: Agent360Payment[]
    /** Genuinely OWED (status 'pending') — disputed rows are tracked separately. */
    pending: Agent360Payment[]
    disputed: Agent360Payment[]
    totalPaid: number
    totalPending: number
    totalDisputed: number
  }
  gamification: {
    points: number
    tier: string
    badges: Agent360Badge[]
    recentPoints: Array<{ points: number; reason: string | null; createdAt: string }>
  }
  /** agent_onboarding row (null = never started — "apply" creates it). */
  onboarding: {
    status: string
    completionPercentage: number
    currentDay: number | null
    certified: boolean
  } | null
  /** Agent-recruiting downline — the tenant decides the program via
   *  brokerages.recruiting_split_to_agent / recruiting_monthly_fee. */
  downline: {
    programOffered: boolean
    splitToAgent: number | null
    monthlyFee: number | null
    joinedCount: number
    recruits: Array<{ name: string; status: string; provisioned: boolean; createdAt: string }>
  }
  academy: {
    assignments: Array<{ moduleId: string; title: string; status: string }>
    availableModules: Array<{ id: string; title: string }>
  }
}

/** Same tier ladder getAgentPointsAndTier computes (thresholds in code, no table). */
function tierFor(points: number): string {
  if (points >= 25000) return "Platinum"
  if (points >= 10000) return "Gold"
  if (points >= 2500) return "Silver"
  if (points >= 500) return "Bronze"
  return "Rookie"
}

export async function getAgent360Action(
  targetUserId: string,
): Promise<{ ok: true; data: Agent360 | null } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: caller } = await supabase
    .from("users")
    .select("user_type, role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  const callerRole = (caller?.user_type ?? caller?.role ?? "") as string
  if (!MANAGER_ROLES.has(callerRole)) return { ok: false, error: "Forbidden" }
  if (!caller?.brokerage_id) return { ok: false, error: "No brokerage on your profile" }

  const svc = createServiceClient()

  // Resolve the target's agent row inside the caller's brokerage — non-agents
  // (TC, vendor, staff) simply have no 360; the page shows the base profile.
  const { data: agent } = await svc
    .from("agents")
    .select("id, ytd_gci, ytd_transactions, cap_progress, cap_amount, gamification_points")
    .eq("user_id", targetUserId)
    .eq("brokerage_id", caller.brokerage_id)
    .maybeSingle()
  if (!agent) return { ok: true, data: null }

  const year = new Date().getFullYear()
  const [goalsRes, commissionsRes, badgesRes, pointsLogRes, activeTxRes,
         onboardingRes, brokerageRes, recruitsRes, assignmentsRes, modulesRes] = await Promise.all([
    svc.from("agent_goals")
      .select("goal_type, target_value, current_value, year")
      .eq("agent_id", agent.id)
      .eq("year", year)
      .order("goal_type"),
    svc.from("commissions")
      .select("id, status, agent_commission, gross_commission, deposit_received_at, created_at")
      .eq("agent_id", agent.id)
      .order("created_at", { ascending: false })
      .limit(50),
    svc.from("agent_badges")
      .select("awarded_at, gamification_badges ( badge_name, badge_icon, badge_tier )")
      .eq("agent_id", agent.id)
      .order("awarded_at", { ascending: false })
      .limit(12),
    svc.from("agent_points_log")
      .select("points, reason, created_at")
      .eq("agent_id", agent.id)
      .order("created_at", { ascending: false })
      .limit(5),
    svc.from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agent.id)
      .in("status", ["active", "under_contract", "closing"]),
    svc.from("agent_onboarding")
      .select("status, completion_percentage, current_day, certification_achieved")
      .eq("agent_id", agent.id)
      .eq("brokerage_id", caller.brokerage_id)
      .maybeSingle(),
    svc.from("brokerages")
      .select("recruiting_split_to_agent, recruiting_monthly_fee")
      .eq("id", caller.brokerage_id)
      .maybeSingle(),
    svc.from("recruits")
      .select("first_name, last_name, status, provisioned, created_at")
      .eq("recruiter_agent_id", agent.id)
      .eq("brokerage_id", caller.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(25),
    svc.from("learning_assignments")
      .select("module_id, status, learning_modules ( title )")
      .eq("agent_user_id", targetUserId)
      .eq("brokerage_id", caller.brokerage_id)
      .limit(50),
    svc.from("learning_modules")
      .select("id, title")
      .eq("brokerage_id", caller.brokerage_id)
      .eq("status", "published")
      .order("title")
      .limit(100),
  ])

  const allCommissions = (commissionsRes.data ?? []).map((c: any): Agent360Payment => ({
    id: c.id,
    status: c.status ?? "pending",
    agentCommission: Number(c.agent_commission) || 0,
    grossCommission: Number(c.gross_commission) || 0,
    depositReceivedAt: c.deposit_received_at ?? null,
    createdAt: c.created_at,
  }))
  // Live commissions.status CHECK vocabulary is pending | paid | disputed.
  // Only 'pending' is genuinely OWED — a disputed commission is contested, not
  // payable, so folding it into pending would overstate what the agent is due.
  const paid = allCommissions.filter(c => c.status === "paid")
  const pending = allCommissions.filter(c => c.status === "pending")
  const disputed = allCommissions.filter(c => c.status === "disputed")

  const badges = (badgesRes.data ?? []).map((b: any): Agent360Badge => {
    const def = Array.isArray(b.gamification_badges) ? b.gamification_badges[0] : b.gamification_badges
    return {
      name: def?.badge_name ?? "Badge",
      icon: def?.badge_icon ?? null,
      tier: def?.badge_tier ?? null,
      awardedAt: b.awarded_at,
    }
  })

  const points = Number(agent.gamification_points) || 0

  return {
    ok: true,
    data: {
      agentId: agent.id as string,
      production: {
        ytdGci: Number(agent.ytd_gci) || 0,
        ytdTransactions: Number(agent.ytd_transactions) || 0,
        capProgress: agent.cap_progress != null ? Number(agent.cap_progress) : null,
        capAmount: agent.cap_amount != null ? Number(agent.cap_amount) : null,
        activeTransactions: activeTxRes.count ?? 0,
      },
      goals: (goalsRes.data ?? []).map((g: any): Agent360Goal => ({
        goalType: g.goal_type,
        targetValue: Number(g.target_value) || 0,
        currentValue: Number(g.current_value) || 0,
        year: g.year,
      })),
      payments: {
        paid,
        pending,
        disputed,
        totalPaid: paid.reduce((s, c) => s + c.agentCommission, 0),
        totalPending: pending.reduce((s, c) => s + c.agentCommission, 0),
        totalDisputed: disputed.reduce((s, c) => s + c.agentCommission, 0),
      },
      gamification: {
        points,
        tier: tierFor(points),
        badges,
        recentPoints: (pointsLogRes.data ?? []).map((p: any) => ({
          points: Number(p.points) || 0,
          reason: p.reason ?? null,
          createdAt: p.created_at,
        })),
      },
      onboarding: onboardingRes.data
        ? {
            status: (onboardingRes.data.status as string) ?? "in_progress",
            completionPercentage: Number(onboardingRes.data.completion_percentage) || 0,
            currentDay: onboardingRes.data.current_day != null ? Number(onboardingRes.data.current_day) : null,
            certified: !!onboardingRes.data.certification_achieved,
          }
        : null,
      downline: {
        // The tenant offers the program by setting a split — no split, no program.
        programOffered: brokerageRes.data?.recruiting_split_to_agent != null,
        splitToAgent: brokerageRes.data?.recruiting_split_to_agent != null
          ? Number(brokerageRes.data.recruiting_split_to_agent) : null,
        monthlyFee: brokerageRes.data?.recruiting_monthly_fee != null
          ? Number(brokerageRes.data.recruiting_monthly_fee) : null,
        joinedCount: (recruitsRes.data ?? []).filter((r: any) => r.provisioned || r.status === "joined").length,
        recruits: (recruitsRes.data ?? []).map((r: any) => ({
          name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "Recruit",
          status: r.status ?? "new",
          provisioned: !!r.provisioned,
          createdAt: r.created_at,
        })),
      },
      academy: {
        assignments: (assignmentsRes.data ?? []).map((a: any) => {
          const mod = Array.isArray(a.learning_modules) ? a.learning_modules[0] : a.learning_modules
          return { moduleId: a.module_id as string, title: mod?.title ?? "Module", status: a.status ?? "open" }
        }),
        availableModules: (modulesRes.data ?? []).map((m: any) => ({ id: m.id as string, title: m.title as string })),
      },
    },
  }
}

// ── Mutations — assign academy classes + apply/pause onboarding ───────────────

async function requireManager(): Promise<
  | { ok: true; brokerageId: string; userId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: caller } = await supabase
    .from("users").select("user_type, role, brokerage_id").eq("id", user.id).maybeSingle()
  const role = (caller?.user_type ?? caller?.role ?? "") as string
  if (!MANAGER_ROLES.has(role)) return { ok: false, error: "Forbidden" }
  if (!caller?.brokerage_id) return { ok: false, error: "No brokerage on your profile" }
  return { ok: true, brokerageId: caller.brokerage_id as string, userId: user.id }
}

/**
 * Assign a published academy module to the agent. Upsert on the live
 * UNIQUE(agent_user_id, module_id) — re-assigning an existing assignment is a
 * friendly no-op, never a duplicate row. Status vocabulary is the live CHECK:
 * new assignments open as 'open'.
 */
export async function assignAcademyModuleAction(
  input: { targetUserId: string; moduleId: string },
): Promise<{ ok: boolean; error?: string; duplicate?: boolean }> {
  const auth = await requireManager()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  // CROSS-TENANT GUARD: the TARGET must belong to the caller's brokerage.
  // Verifying only the module let a manager write a learning_assignments row
  // for a user in another tenant (VADE security finding).
  const { data: targetUser } = await svc
    .from("users")
    .select("id, brokerage_id")
    .eq("id", input.targetUserId)
    .maybeSingle()
  if (!targetUser || targetUser.brokerage_id !== auth.brokerageId) {
    return { ok: false, error: "User not found in your brokerage" }
  }

  const { data: mod } = await svc
    .from("learning_modules")
    .select("id, brokerage_id, status")
    .eq("id", input.moduleId)
    .maybeSingle()
  if (!mod || mod.brokerage_id !== auth.brokerageId) return { ok: false, error: "Module not found in your academy" }
  if (mod.status !== "published") return { ok: false, error: "Module isn't published yet" }

  const { data: existing } = await svc
    .from("learning_assignments")
    .select("id")
    .eq("agent_user_id", input.targetUserId)
    .eq("module_id", input.moduleId)
    .maybeSingle()
  if (existing) return { ok: true, duplicate: true }

  const { error } = await svc.from("learning_assignments").insert({
    brokerage_id: auth.brokerageId,
    module_id: input.moduleId,
    agent_user_id: input.targetUserId,
    signal_source: "manager_assigned",
    status: "open",
  })
  if (error) return { ok: false, error: error.message }
  revalidatePath(`/dashboard/admin/users/${input.targetUserId}`)
  return { ok: true }
}

/**
 * Apply / pause / resume onboarding for the agent ("apply or remove
 * onboarding" — walkthrough [47]). Applying with no row creates one; the live
 * status vocabulary is in_progress | completed | paused, so "remove" is pause.
 */
export async function setAgentOnboardingStatusAction(
  input: { targetUserId: string; status: "in_progress" | "paused" },
): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireManager()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  const { data: agent } = await svc
    .from("agents").select("id")
    .eq("user_id", input.targetUserId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (!agent) return { ok: false, error: "No agent record for this user" }

  const { data: existing } = await svc
    .from("agent_onboarding")
    .select("id, status")
    .eq("agent_id", agent.id)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()

  if (!existing) {
    if (input.status === "paused") return { ok: false, error: "Onboarding was never started for this agent" }
    const { error } = await svc.from("agent_onboarding").insert({
      agent_id: agent.id,
      user_id: input.targetUserId,
      brokerage_id: auth.brokerageId,
      status: "in_progress",
      current_day: 1,
      completion_percentage: 0,
      start_date: new Date().toISOString(),
    })
    if (error) return { ok: false, error: error.message }
  } else {
    if (existing.status === "completed") return { ok: false, error: "Onboarding is already completed" }
    const { error } = await svc.from("agent_onboarding")
      .update({ status: input.status, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
    if (error) return { ok: false, error: error.message }
  }
  revalidatePath(`/dashboard/admin/users/${input.targetUserId}`)
  return { ok: true }
}
