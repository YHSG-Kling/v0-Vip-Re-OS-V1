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
    pending: Agent360Payment[]
    totalPaid: number
    totalPending: number
  }
  gamification: {
    points: number
    tier: string
    badges: Agent360Badge[]
    recentPoints: Array<{ points: number; reason: string | null; createdAt: string }>
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
  const [goalsRes, commissionsRes, badgesRes, pointsLogRes, activeTxRes] = await Promise.all([
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
  ])

  const allCommissions = (commissionsRes.data ?? []).map((c: any): Agent360Payment => ({
    id: c.id,
    status: c.status ?? "pending",
    agentCommission: Number(c.agent_commission) || 0,
    grossCommission: Number(c.gross_commission) || 0,
    depositReceivedAt: c.deposit_received_at ?? null,
    createdAt: c.created_at,
  }))
  const paid = allCommissions.filter(c => c.status === "paid")
  const pending = allCommissions.filter(c => c.status !== "paid")

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
        totalPaid: paid.reduce((s, c) => s + c.agentCommission, 0),
        totalPending: pending.reduce((s, c) => s + c.agentCommission, 0),
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
    },
  }
}
