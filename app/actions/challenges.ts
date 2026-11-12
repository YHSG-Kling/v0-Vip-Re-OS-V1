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

  // team_id ARRIVES IN THE BODY, so it is verified against the session's tenant before it
  // is stored — otherwise the team predicate the board now applies (getChallenges below)
  // could be pointed at another brokerage's team id and would then hide the challenge
  // from everyone in this one. Tenant comes from the session; the team only has to be
  // INSIDE it (§4).
  if (input.teamId) {
    const { data: team, error: teamError } = await svc
      .from("teams").select("id").eq("id", input.teamId).eq("brokerage_id", auth.brokerageId).maybeSingle()
    if (teamError) return { ok: false, error: `Could not verify the team: ${teamError.message}` }
    if (!team) return { ok: false, error: "That team is not in your brokerage" }
  }

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

  const { data: challenge } = await svc.from("challenges").select("id, brokerage_id, team_id, status").eq("id", input.challengeId).maybeSingle()
  if (!challenge || (challenge as any).brokerage_id !== ctx.brokerageId) return { ok: false, error: "Challenge not found" }
  if ((challenge as any).status === "ended" || (challenge as any).status === "cancelled") return { ok: false, error: "Challenge is closed" }

  // THE SAME TEAM PREDICATE THE BOARD NOW APPLIES. Without it the read is scoped and the
  // WRITE is not: an agent who never sees another team's challenge could still enroll in
  // it by posting its id, and every export of a "use server" file is a public HTTP
  // endpoint (§4). A team is a mini brokerage, so a team's challenge admits that team
  // only; team_id NULL is brokerage-wide. Brokerage admins administer every team.
  const challengeTeamId = (challenge as any).team_id as string | null
  if (challengeTeamId && !ADMIN_ROLES.has(ctx.role) && ctx.teamId !== challengeTeamId) {
    return { ok: false, error: "Challenge not found" }
  }

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

export interface ChallengeStanding {
  agentId: string
  agentName: string
  value: number
  rank: number
  isWinner: boolean
  enrolled: boolean
  /** challenge_participants.prize_awarded — whether the finalize actually moved the
   *  points into the gamification ledger for this winner. Written by
   *  lib/recruiting/challenge-runner.ts:98 and read by nothing until w26: a winner
   *  could be crowned on the board while awardAgentPoints failed (the runner logs and
   *  continues at :96), and nobody could see the difference. */
  prizeAwarded: boolean
}
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
  /** challenges.team_id — null for a brokerage-wide challenge, otherwise the team
   *  this competition belongs to. Written at :53 and, until w26, read by nothing. */
  teamId: string | null
  /**
   * Where the standings came from.
   *   · "final" — the crowned RESULT OF RECORD, read back from
   *     challenge_participants.current_rank / current_value, which the finalize
   *     stamped at the moment the challenge ended (challenge-runner.ts:79).
   *   · "live"  — recomputed now by the same scorer the cron uses.
   * An ENDED challenge must show what was crowned, not a fresh recount: the window
   * is closed but the underlying rows are not frozen, so a late-recorded closing
   * could silently re-order a leaderboard whose prizes are already paid.
   */
  standingsSource: "live" | "final"
}

/** Broker/agent read — the brokerage's challenges with LIVE standings (same scorer the cron finalizes with). */
export async function getChallenges(): Promise<{ challenges: ChallengeView[] }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { challenges: [] }
  const svc = createServiceClient()
  const now = new Date()

  // A TEAM IS A MINI BROKERAGE (CLAUDE.md §4), so this predicate is a TENANCY rule,
  // not a filter preference. createChallenge has always stored team_id (:53) and this
  // read had no team predicate at all, so every agent in the brokerage saw — and could
  // enroll in — another team's competition, and a team lead's board was indistinguishable
  // from the brokerage's. A brokerage-wide challenge (team_id NULL) belongs to everyone;
  // a team's challenge belongs to that team. Brokerage admins administer every team, so
  // they keep seeing all of them. An agent with NO team sees only the brokerage-wide ones
  // (fail closed: no team id can never mean "every team").
  let challengeQuery = svc.from("challenges")
    .select("id, brokerage_id, team_id, title, description, challenge_type, starts_at, ends_at, status, prize_points, prize_description, winner_count")
    .eq("brokerage_id", ctx.brokerageId)
  if (!ADMIN_ROLES.has(ctx.role)) {
    challengeQuery = ctx.teamId
      ? challengeQuery.or(`team_id.is.null,team_id.eq.${ctx.teamId}`)
      : challengeQuery.is("team_id", null)
  }
  const { data: rows, error: challengesError } = await challengeQuery
    .order("starts_at", { ascending: false }).limit(50)
  // §3 — supabase-js RESOLVES a refusal, and an empty board is this surface's normal
  // state, so a refused read would be invisible forever.
  if (challengesError) {
    console.error("[challenges] challenge read refused:", challengesError.message)
    return { challenges: [] }
  }

  const out: ChallengeView[] = []
  for (const c of (rows ?? []) as any[]) {
    // The STORED result of record rides along with the roster — one read, not two.
    const { data: parts } = await svc.from("challenge_participants")
      .select("agent_id, current_rank, current_value, is_winner, prize_awarded")
      .eq("challenge_id", c.id).limit(2000)
    const partRows = (parts ?? []) as any[]
    const agentIds = partRows.map((p) => p.agent_id)
    const prizeByAgent = new Map<string, boolean>(partRows.map((p) => [p.agent_id, p.prize_awarded === true]))
    const status = challengeStatus(c.status, c.starts_at, c.ends_at, now)

    // An ENDED challenge shows what was CROWNED, when the finalize actually stamped it.
    // A partially-stamped set (the cron died mid-loop) falls back to a live recount
    // rather than showing half a leaderboard.
    const hasStoredResult =
      status === "ended" && partRows.length > 0 && partRows.every((p) => typeof p.current_rank === "number")
    let standingsSource: ChallengeView["standingsSource"] = hasStoredResult ? "final" : "live"

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
      if (hasStoredResult) {
        standings = partRows
          .slice()
          .sort((a, b) => Number(a.current_rank) - Number(b.current_rank))
          .map((p) => ({
            agentId: p.agent_id,
            agentName: nameById.get(p.agent_id) ?? "Agent",
            value: Number(p.current_value ?? 0),
            rank: Number(p.current_rank),
            isWinner: p.is_winner === true,
            enrolled: true,
            prizeAwarded: p.prize_awarded === true,
          }))
      } else {
        const scored = await scoreChallenge(svc, c as ChallengeRow, agentIds, now)
        standings = rankParticipants(scored, c.winner_count).map((r) => ({
          agentId: r.agentId, agentName: nameById.get(r.agentId) ?? "Agent", value: r.value, rank: r.rank,
          isWinner: r.isWinner, enrolled: true,
          prizeAwarded: prizeByAgent.get(r.agentId) === true,
        }))
      }
    } else {
      // Nothing scored, so nothing was read back either — do not claim a final board.
      standingsSource = "live"
    }

    out.push({
      id: c.id, title: c.title, description: c.description, challengeType: c.challenge_type as ChallengeType,
      metricLabel: CHALLENGE_METRIC[c.challenge_type as ChallengeType] ?? "metric",
      startsAt: c.starts_at, endsAt: c.ends_at, status, prizePoints: c.prize_points ?? 0,
      prizeDescription: c.prize_description, winnerCount: c.winner_count ?? 1,
      participantCount: agentIds.length, standings,
      youEnrolled: !!ctx.agentId && agentIds.includes(ctx.agentId),
      teamId: (c.team_id as string | null) ?? null,
      standingsSource,
    })
  }
  return { challenges: out }
}
