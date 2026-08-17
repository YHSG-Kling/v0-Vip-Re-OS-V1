"use server"

// app/actions/challenges.ts
// ─────────────────────────────────────────────────────────────────────────────
// GAMIFICATION CHALLENGES (recruiting_manager) — broker/team-run, time-boxed competitions.
// Create is admin-gated (a challenge sets prize points on the shared ledger); enroll is self-serve
// for any agent in the brokerage; the standings read computes LIVE values from the consolidated data
// (agent_points_log / transactions / contacts / referrals) via the same scorer the cron uses — so the
// board an agent sees mid-challenge matches exactly what finalize will crown.

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import {
  CHALLENGE_METRIC, challengeStatus, rankParticipants,
  type ChallengeType, type ChallengeStatus,
} from "@/lib/recruiting/challenges"
import { scoreChallenge, type ChallengeRow } from "@/lib/recruiting/challenge-runner"

// TENANT ADMIN GATE (kept inline, mirrored by app/dashboard/challenges/page.tsx):
// 'superadmin' removed — dead as users.user_type (0 live rows store it).
const ADMIN_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin"])

async function requireAdmin() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false as const, reason: "Unauthorized" }
  if (!ADMIN_ROLES.has(ctx.role)) return { ok: false as const, reason: "Forbidden — admin only" }
  return { ok: true as const, brokerageId: ctx.brokerageId, actorUserId: ctx.userId }
}

const CHALLENGE_TYPES: ChallengeType[] = ["most_points", "most_transactions", "most_contacts", "most_referrals", "custom"]

/** ADMIN — create a time-boxed challenge (draft/active resolved from its window). */
export async function createChallenge(input: {
  title: string
  description?: string
  challengeType: ChallengeType
  startsAt: string
  endsAt: string
  prizePoints?: number
  prizeDescription?: string
  winnerCount?: number
  teamId?: string | null
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.reason }
  if (!input.title?.trim()) return { ok: false, error: "Title is required" }
  if (!CHALLENGE_TYPES.includes(input.challengeType)) return { ok: false, error: "Unknown challenge type" }
  if (Date.parse(input.startsAt) >= Date.parse(input.endsAt)) return { ok: false, error: "End must be after start" }

  const svc = createServiceClient()
  const { data, error } = await svc.from("challenges").insert({
    brokerage_id: auth.brokerageId,
    team_id: input.teamId ?? null,
    title: input.title.trim(),
    description: input.description ?? null,
    challenge_type: input.challengeType,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    prize_points: Math.max(0, Math.floor(input.prizePoints ?? 0)),
    prize_description: input.prizeDescription ?? null,
    winner_count: Math.max(1, Math.floor(input.winnerCount ?? 1)),
    status: "active",
    created_by: auth.actorUserId,
  }).select("id").single()
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" }
  return { ok: true, id: (data as any).id }
}

/** Enroll the current agent (or a named agent for an admin) in a challenge. Idempotent per (challenge, agent). */
export async function enrollInChallenge(input: { challengeId: string; agentId?: string }): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()

  const { data: challenge } = await svc.from("challenges").select("id, brokerage_id, status").eq("id", input.challengeId).maybeSingle()
  if (!challenge || (challenge as any).brokerage_id !== ctx.brokerageId) return { ok: false, error: "Challenge not found" }
  if ((challenge as any).status === "ended" || (challenge as any).status === "cancelled") return { ok: false, error: "Challenge is closed" }

  // Admins may enroll another agent; everyone else may only enroll themselves.
  const targetAgentId = input.agentId && ADMIN_ROLES.has(ctx.role) ? input.agentId : ctx.agentId
  if (!targetAgentId) return { ok: false, error: "No agent to enroll" }

  const { data: agentRow } = await svc.from("agents").select("id").eq("id", targetAgentId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
  if (!agentRow) return { ok: false, error: "Agent not in this brokerage" }

  const { error } = await svc.from("challenge_participants")
    .upsert({ challenge_id: input.challengeId, agent_id: targetAgentId }, { onConflict: "challenge_id,agent_id", ignoreDuplicates: true })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export interface ChallengeStanding { agentId: string; agentName: string; value: number; rank: number; isWinner: boolean; enrolled: boolean }
export interface ChallengeView {
  id: string
  title: string
  description: string | null
  challengeType: ChallengeType
  metricLabel: string
  startsAt: string
  endsAt: string
  status: ChallengeStatus
  prizePoints: number
  prizeDescription: string | null
  winnerCount: number
  participantCount: number
  standings: ChallengeStanding[]
  youEnrolled: boolean
}

/** Broker/agent read — the brokerage's challenges with LIVE standings (same scorer the cron finalizes with). */
export async function getChallenges(): Promise<{ challenges: ChallengeView[] }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { challenges: [] }
  const svc = createServiceClient()
  const now = new Date()

  const { data: rows } = await svc.from("challenges")
    .select("id, brokerage_id, title, description, challenge_type, starts_at, ends_at, status, prize_points, prize_description, winner_count")
    .eq("brokerage_id", ctx.brokerageId).order("starts_at", { ascending: false }).limit(50)

  const out: ChallengeView[] = []
  for (const c of (rows ?? []) as any[]) {
    const { data: parts } = await svc.from("challenge_participants").select("agent_id").eq("challenge_id", c.id).limit(2000)
    const agentIds = ((parts ?? []) as any[]).map((p) => p.agent_id)
    const status = challengeStatus(c.status, c.starts_at, c.ends_at, now)

    // Live standings (only worth scoring once it has started).
    let standings: ChallengeStanding[] = []
    if (agentIds.length > 0 && status !== "draft") {
      // agents carry no name of their own — resolve via user_id → users (first/last name).
      const { data: agentRows } = await svc.from("agents").select("id, user_id").in("id", agentIds)
      const userIdByAgent = new Map<string, string>(((agentRows ?? []) as any[]).filter((a) => a.user_id).map((a) => [a.id, a.user_id]))
      const userIds = Array.from(new Set(userIdByAgent.values()))
      const { data: userRows } = userIds.length ? await svc.from("users").select("id, first_name, last_name").in("id", userIds) : { data: [] as any[] }
      const nameByUser = new Map<string, string>(((userRows ?? []) as any[]).map((u) => [u.id, `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Agent"]))
      const nameById = new Map<string, string>(agentIds.map((id) => [id, nameByUser.get(userIdByAgent.get(id) ?? "") ?? "Agent"]))
      const scored = await scoreChallenge(svc, c as ChallengeRow, agentIds, now)
      standings = rankParticipants(scored, c.winner_count).map((r) => ({
        agentId: r.agentId, agentName: nameById.get(r.agentId) ?? "Agent", value: r.value, rank: r.rank,
        isWinner: r.isWinner, enrolled: true,
      }))
    }

    out.push({
      id: c.id, title: c.title, description: c.description, challengeType: c.challenge_type as ChallengeType,
      metricLabel: CHALLENGE_METRIC[c.challenge_type as ChallengeType] ?? "metric",
      startsAt: c.starts_at, endsAt: c.ends_at, status, prizePoints: c.prize_points ?? 0,
      prizeDescription: c.prize_description, winnerCount: c.winner_count ?? 1,
      participantCount: agentIds.length, standings,
      youEnrolled: !!ctx.agentId && agentIds.includes(ctx.agentId),
    })
  }
  return { challenges: out }
}
