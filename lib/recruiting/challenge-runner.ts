// lib/recruiting/challenge-runner.ts
//
// CHALLENGE SCORING + FINALIZE (recruiting_manager) — computes each participant's value from the
// consolidated data over the challenge window, ranks them, and on end crowns winners + awards prize
// points into the SAME gamification ledger + proposes a gated winner announcement. Best-effort.

import { createServiceClient } from "@/lib/supabase/service"
import { rankParticipants, challengeStatus, type ChallengeType, type Participant } from "@/lib/recruiting/challenges"

type Svc = ReturnType<typeof createServiceClient>

export interface ChallengeRow { id: string; brokerage_id: string; title: string; challenge_type: string; starts_at: string; ends_at: string; status: string; prize_points: number; winner_count: number }

/** Score each enrolled agent for a challenge over [starts_at, min(now, ends_at)] by its metric type. */
export async function scoreChallenge(svc: Svc, challenge: ChallengeRow, agentIds: string[], now: Date): Promise<Participant[]> {
  if (agentIds.length === 0) return []
  const start = challenge.starts_at
  const end = (Date.parse(challenge.ends_at) < now.getTime() ? challenge.ends_at : now.toISOString())
  const type = challenge.challenge_type as ChallengeType
  const value = new Map<string, number>(agentIds.map((id) => [id, 0]))

  const add = (id: string, n: number) => { if (value.has(id)) value.set(id, (value.get(id) ?? 0) + n) }

  try {
    if (type === "most_points") {
      const { data } = await svc.from("agent_points_log").select("agent_id, points").in("agent_id", agentIds).gte("created_at", start).lte("created_at", end)
      for (const r of (data ?? []) as any[]) add(r.agent_id, Number(r.points) || 0)
    } else if (type === "most_transactions") {
      // SAME DEFINITION THE LEADERBOARD'S `transactions` METRIC USES: a deal has
      // closed at `closed` (recorded) or `funded` (disbursed). This counted only
      // `closed`, so a challenge and the board could rank the same two agents in a
      // different order over the same window.
      const { data } = await svc.from("transactions").select("agent_id").in("agent_id", agentIds).in("status", ["closed", "funded"]).gte("close_date", start.slice(0, 10)).lte("close_date", end.slice(0, 10))
      for (const r of (data ?? []) as any[]) add(r.agent_id, 1)
    } else if (type === "most_contacts") {
      // CONTACTS the agent manages (not the ISA lead queue).
      const { data } = await svc.from("contacts").select("agent_id").in("agent_id", agentIds).gte("created_at", start).lte("created_at", end)
      for (const r of (data ?? []) as any[]) add(r.agent_id, 1)
    } else if (type === "most_referrals") {
      // `referring_agent_id` IS THE AGENT WHO SENT THE REFERRAL and earns the fee;
      // `agent_id` is the agent who RECEIVED it. This credited the receiver, so
      // "most referrals" ranked whoever was handed the most work. Same column the
      // leaderboard's `referrals` metric counts.
      const { data } = await svc.from("referrals").select("referring_agent_id").in("referring_agent_id", agentIds).gte("created_at", start).lte("created_at", end)
      for (const r of (data ?? []) as any[]) add(r.referring_agent_id, 1)
    }
    // custom → left at 0 (no auto metric).
  } catch { /* best-effort; unavailable metric → zeros */ }

  return agentIds.map((id) => ({ agentId: id, value: value.get(id) ?? 0 }))
}

export interface ChallengeScoringResult { active: number; scored: number; finalized: number; prizesAwarded: number }

/** Score all active challenges for a brokerage (live standings) + finalize any that have ended. */
export async function runChallengeScoring(svc: Svc, params: { brokerageId: string; now?: Date }): Promise<ChallengeScoringResult> {
  const out: ChallengeScoringResult = { active: 0, scored: 0, finalized: 0, prizesAwarded: 0 }
  const now = params.now ?? new Date()
  const { data: challenges } = await svc.from("challenges").select("id, brokerage_id, title, challenge_type, starts_at, ends_at, status, prize_points, winner_count").eq("brokerage_id", params.brokerageId).in("status", ["active", "draft"]).limit(200)

  for (const c of (challenges ?? []) as ChallengeRow[]) {
    const computed = challengeStatus(c.status, c.starts_at, c.ends_at, now)
    if (computed === "draft") continue
    out.active += 1

    const { data: parts } = await svc.from("challenge_participants").select("id, agent_id").eq("challenge_id", c.id).limit(2000)
    const agentIds = ((parts ?? []) as any[]).map((p) => p.agent_id)
    const idByAgent = new Map<string, string>(((parts ?? []) as any[]).map((p) => [p.agent_id, p.id]))
    if (agentIds.length === 0) continue

    const scored = await scoreChallenge(svc, c, agentIds, now)
    const ranked = rankParticipants(scored, c.winner_count)
    out.scored += ranked.length

    const ending = computed === "ended"
    for (const r of ranked) {
      const rowId = idByAgent.get(r.agentId)
      if (!rowId) continue
      await svc.from("challenge_participants").update({ current_value: r.value, current_rank: r.rank, is_winner: ending ? r.isWinner : false }).eq("id", rowId)
    }

    if (ending && c.status !== "ended") {
      // Finalize: award prize points to winners (into the consolidated ledger) + a gated announcement.
      const winners = ranked.filter((r) => r.isWinner)
      if (c.prize_points > 0 && winners.length > 0) {
        // THE ONE ATOMIC AWARD PATH (m484). A raw ledger insert stood here, which
        // moved the leaderboard and left agents.gamification_points behind — so a
        // challenge winner's prize counted on the board and never toward their tier
        // or their badges.
        const { awardAgentPoints } = await import("@/lib/gamification/award-points")
        for (const w of winners) {
          const awarded = await awardAgentPoints(svc, {
            agentId: w.agentId, points: c.prize_points, reason: "CHALLENGE_PRIZE",
            referenceType: "challenge", referenceId: c.id,
          })
          if (!awarded.ok) console.error(`[challenge-runner] prize not awarded for challenge ${c.id}: ${awarded.error}`)
        }
        await svc.from("challenge_participants").update({ prize_awarded: true }).eq("challenge_id", c.id).eq("is_winner", true)
        out.prizesAwarded += winners.length
      }
      await svc.from("challenges").update({ status: "ended", updated_at: now.toISOString() }).eq("id", c.id)
      out.finalized += 1
      try {
        const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
        await proposeClientMessage({
          brokerageId: params.brokerageId, agentKind: "recruiting_manager", entityType: "brokerage", entityId: params.brokerageId,
          recipientContactId: null, audience: "agent",
          subject: `Challenge wrapped: ${c.title}`,
          body: `The "${c.title}" challenge just ended. ${winners.length} winner${winners.length === 1 ? "" : "s"} earned ${c.prize_points} points. Post the results to the team feed to celebrate — a little recognition goes a long way.`,
          rationale: `CHALLENGE FINALIZE — ${c.id}; ${winners.length} winner(s); review before posting.`,
          channel: "portal",
        }, svc)
      } catch { /* best-effort */ }
    }
  }
  return out
}

/** Autonomous: score + finalize challenges across every brokerage (rides the weekly recruit-outreach cron). */
export async function runChallengeScoringAll(svc: Svc, now?: Date): Promise<{ brokerages: number; finalized: number }> {
  const out = { brokerages: 0, finalized: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runChallengeScoring(svc, { brokerageId: b.id, now }); out.finalized += r.finalized } catch { /* keep going */ }
  }
  return out
}
