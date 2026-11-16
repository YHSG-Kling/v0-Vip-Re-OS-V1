"use server"

// app/actions/gamification.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE AGENT-FACING GAMIFICATION READS + THE BADGE AWARDER.
//
// "use server" IS NEW AND IT IS NOT COSMETIC. This module is imported directly by
// CLIENT components (app/dashboard/motivation/motivation-client.tsx and
// app/academy/components/os/embedded-leaderboard-widget.tsx; the third,
// app/lib/gamification/award-on-action.ts, was retired in wave 153) while itself importing
// @/lib/supabase/server, which reaches for next/headers. Without the directive
// these are not server actions at all — the module is pulled into the client
// bundle and the import fails. The Motivation surface could not have rendered
// whatever the data said. POINT_VALUES moved to lib/gamification/award-points.ts
// because a "use server" module may only export async functions, and that is its
// right home anyway: it is award vocabulary, not a read.
//
// Everything the leaderboard reads now comes from ONE vocabulary module
// (lib/gamification/leaderboard-vocabulary.ts) shared with the populator, and the
// tier ladder from ONE module (lib/gamification/tiers.ts) shared with Agent 360
// and the Intelligence page.

import { createClient } from "@/lib/supabase/server"
import {
  isLeaderboardScope,
  isLeaderboardMetric,
  isCanonicalPeriodLabel,
  defaultPeriodLabel,
  monthLabel,
  type LeaderboardRow,
} from "@/lib/gamification/leaderboard-vocabulary"
import { tierForPoints, tierLabelForPoints, nextTierForPoints, tierProgressPercent } from "@/lib/gamification/tiers"

// The embed every board read shares. `agents` carries no name of its own — a
// person's name is on `users`, reached through the single agents_user_id_fkey, so
// the embed is an OBJECT.
const RANKING_SELECT = `
  id,
  rank_position,
  metric_type,
  metric_value,
  agent_id,
  team_id,
  brokerage_id,
  scope,
  period_label,
  computed_at,
  agents:agent_id(id, gamification_points, photo_url, profile_image_url, users:user_id(first_name, last_name))
`

function toLeaderboardRow(row: any, currentAgentId: string | null): LeaderboardRow {
  const a = row?.agents ?? null
  const u = a?.users ?? null
  const name = `${u?.first_name ?? ""} ${u?.last_name ?? ""}`.trim()
  return {
    agentId: row.agent_id,
    agentName: name || "Agent",
    avatarUrl: a?.photo_url ?? a?.profile_image_url ?? null,
    rank: Number(row.rank_position) || 0,
    score: Number(row.metric_value) || 0,
    lifetimePoints: Number(a?.gamification_points) || 0,
    isCurrentAgent: !!currentAgentId && row.agent_id === currentAgentId,
  }
}

// ─── GET AGENT BADGES ─────────────────────────────────────────────────────────
/**
 * The badge catalog with this agent's awards folded in — ONE list, each row
 * carrying whether it is earned. It used to return `{ earned, all, earnedBadgeIds }`
 * where earnedBadgeIds was a `Set`, and the Motivation page consumed the whole
 * object as if it were an array (`badges.filter(...)`), so the Badges Showcase
 * rendered empty no matter what was awarded.
 */
export async function getAgentBadges(agentId: string): Promise<{
  ok: boolean
  badges: Array<{
    id: string
    badgeId: string
    name: string
    description: string | null
    icon: string | null
    tier: string | null
    category: string | null
    requiredPoints: number
    earned: boolean
    earnedAt: string | null
  }>
  error?: string
}> {
  if (!agentId) return { ok: true, badges: [] }
  const supabase = await createClient()

  const [{ data: earnedRows, error: earnedError }, { data: catalog, error: catalogError }] = await Promise.all([
    supabase
      .from("agent_badges")
      .select("id, badge_id, awarded_at, awarded_reason")
      .eq("agent_id", agentId)
      .order("awarded_at", { ascending: false }),
    supabase
      .from("gamification_badges")
      .select("id, badge_name, badge_description, badge_icon, badge_tier, badge_category, required_points")
      .eq("is_active", true)
      .order("required_points", { ascending: true }),
  ])

  // A refused read is not an empty catalog — say which read failed.
  if (catalogError) return { ok: false, badges: [], error: `Could not load the badge catalog: ${catalogError.message}` }
  if (earnedError) return { ok: false, badges: [], error: `Could not load this agent's awarded badges: ${earnedError.message}` }

  const earnedAtByBadge = new Map<string, string | null>(
    ((earnedRows ?? []) as Array<{ badge_id: string; awarded_at: string | null }>).map((r) => [r.badge_id, r.awarded_at]),
  )

  return {
    ok: true,
    badges: ((catalog ?? []) as any[]).map((b) => ({
      id: b.id,
      badgeId: b.id,
      name: b.badge_name,
      description: b.badge_description ?? null,
      icon: b.badge_icon ?? null,
      tier: b.badge_tier ?? null,
      category: b.badge_category ?? null,
      requiredPoints: Number(b.required_points) || 0,
      earned: earnedAtByBadge.has(b.id),
      earnedAt: earnedAtByBadge.get(b.id) ?? null,
    })),
  }
}

// ─── GET AGENT POINTS AND TIER ────────────────────────────────────────────────
export async function getAgentPointsAndTier(agentId: string) {
  const supabase = await createClient()

  const { data: agent, error } = await supabase
    .from("agents")
    .select("id, gamification_points, users:user_id(first_name, last_name)")
    .eq("id", agentId)
    .single()

  if (error) throw error

  const points = agent?.gamification_points || 0
  const next = nextTierForPoints(points)

  // FATIGUE-AWARE (wave 103, lane 103C): the rail stands down its "N pts to go"
  // pressure for an agent the retention radar has under strain. Read from the
  // radar's stored row (lib/gamification/strain.ts), never re-derived; an unknown
  // (refused read) is treated as NOT strained so a flaky read never hides a rung.
  const { isAgentUnderStrain } = await import("@/lib/gamification/strain")
  const underStrain = (await isAgentUnderStrain(supabase, agentId)) === true

  return {
    agentId: agent?.id,
    agentName: `${(agent?.users as any)?.first_name || ""} ${(agent?.users as any)?.last_name || ""}`.trim(),
    points,
    /** Canonical id — lowercase, the spelling gamification_badges.badge_tier enforces. */
    currentTierId: tierForPoints(points),
    /** What a person reads. */
    currentTier: tierLabelForPoints(points),
    nextTier: next?.label ?? null,
    pointsToNextTier: next?.pointsToGo ?? 0,
    progressPercent: tierProgressPercent(points),
    /** True when the Motivation rail should show support instead of a push. */
    underStrain,
  }
}

// ─── AWARD BADGE — module-private wrapper RETIRED (wave 153, lane 153I) ──────
// TOMBSTONE (CLAUDE.md §1): the private `awardBadge` that wrapped lib/gamification/lifecycle-awards.ts awardBadgeToAgent for
// the threshold loop stood here. The threshold loop itself moved to lifecycle-awards.ts awardThresholdBadges (which reads the
// stored total and calls awardBadgeToAgent — still the ONE agent_badges writer), so the wrapper had no caller left.
// It was never exported, deliberately: a badge-forging endpoint is what this file must not hold (wave 103 note, preserved in
// awardBadgeToAgent's header).

// ─── CHECK AND AWARD BADGES ───────────────────────────────────────────────────
/**
 * Threshold badges for an agent, against the total the DATABASE holds. WAVE 153 (lane 153I): `currentPoints` is RETAINED
 * AND IGNORED (house pattern — the caller keeps type-checking). This is a public endpoint, and it awarded against whatever
 * number it was handed, so any seat could hand its own agents.id and 999999 and take every rung. The award now delegates to
 * lib/gamification/lifecycle-awards.ts awardThresholdBadges, which reads agents.gamification_points itself (the cookie client:
 * RLS confines the agent to the caller's tenant) — calling it can only award what the agent already earned.
 */
export async function checkAndAwardBadges(agentId: string, _currentPoints?: number) {
  const supabase = await createClient()
  const { awardThresholdBadges } = await import("@/lib/gamification/lifecycle-awards")
  const res = await awardThresholdBadges(supabase, { agentId })
  if (res.refused.length > 0) console.error(`[checkAndAwardBadges] ${agentId}: ${res.refused.join(" | ")}`)
  return res.awarded
}

// ─── ADD POINTS — RETIRED (wave 153, lane 153I) ───────────────────────────────
// TOMBSTONE (CLAUDE.md §1). `export async function addPoints(agentId, pointType)` stood here. This file is "use server",
// so it was a PUBLIC endpoint: any signed-in seat could POST (its own agents.id, "FIRST_CLOSE") in a loop — m484's
// award_agent_points() admits an agent crediting ITSELF, and nothing asked whether the outcome happened. Every POINT_VALUES
// reason (LISTING_CLOSED, CAP_HIT, CERTIFICATION_EARNED…) was one click away, with no reference and no once-key, on the board
// the owner asked to be competitive ("credit from verified outcomes only"). Its one caller,
// app/lib/gamification/award-on-action.ts, is retired with it. SURVIVOR: lib/gamification/lifecycle-awards.ts
// awardLifecycleMilestones — called by lib/kernel/event-reactor.ts (L6) on the canonical event that PROVES the outcome, once
// per (agent, reason, reference | window) through lib/gamification/award-points.ts awardAgentPointsOnce. The threshold badge
// awarder (checkAndAwardBadges above) still runs against a total the database already holds.

// ─── RECENT POINT AWARDS ──────────────────────────────────────────────────────
/**
 * The agent's own ledger, newest first. The Motivation page had a "Points History"
 * panel reading `pointsData.pointsHistory` — a key nothing ever set, so the panel
 * has always said "Complete actions to start earning points!" no matter how many
 * points the agent had. This is the read that key was waiting for.
 */
export async function getAgentPointsHistory(
  agentId: string,
  limit = 8,
): Promise<{ ok: boolean; entries: Array<{ points: number; reason: string; createdAt: string }>; error?: string }> {
  if (!agentId) return { ok: true, entries: [] }
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agent_points_log")
    .select("points, reason, created_at")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 50))

  if (error) return { ok: false, entries: [], error: `Could not load your points history: ${error.message}` }

  return {
    ok: true,
    entries: ((data ?? []) as any[]).map((r) => ({
      points: Number(r.points) || 0,
      reason: (r.reason as string) || "Activity",
      createdAt: r.created_at as string,
    })),
  }
}

// ─── GET LEADERBOARD ──────────────────────────────────────────────────────────
/**
 * THE BOARD. Scope, metric and period are validated against the shared vocabulary
 * before they reach the query: an unknown value falls back to the default rather
 * than being handed to PostgREST, which is how "This Month" used to become a
 * silent zero-row filter.
 *
 * TEAM SCOPE IS THE VIEWER'S OWN TEAM (ruling #191). The caller does not name a
 * team; it is resolved from their agents row, so "team" cannot be used to read
 * another team's standings.
 */
export async function getLeaderboard(options: {
  scope?: string
  metricType?: string
  periodLabel?: string
  limit?: number
  offset?: number
}): Promise<{
  ok: boolean
  rankings: LeaderboardRow[]
  currentAgentId: string | null
  brokerageId: string
  scope: string
  metricType: string
  periodLabel: string
  error?: string
}> {
  const scope = isLeaderboardScope(options.scope) ? options.scope : "brokerage"
  const metricType = isLeaderboardMetric(options.metricType) ? options.metricType : "points"
  const periodLabel = isCanonicalPeriodLabel(options.periodLabel) ? (options.periodLabel as string) : defaultPeriodLabel()
  const blank = { rankings: [] as LeaderboardRow[], currentAgentId: null, brokerageId: "", scope, metricType, periodLabel }

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, ...blank, error: "Not authenticated" }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (profileError) return { ok: false, ...blank, error: `Could not resolve your brokerage: ${profileError.message}` }
  if (!profile?.brokerage_id) return { ok: false, ...blank, error: "Your account is not linked to a brokerage yet." }

  // The viewer's own agents row: highlights their line, and supplies the team.
  const { data: viewerAgent } = await supabase
    .from("agents")
    .select("id, team_id")
    .eq("user_id", user.id)
    .maybeSingle()
  const currentAgentId = viewerAgent?.id ?? null

  let query = supabase
    .from("leaderboard_rankings")
    .select(RANKING_SELECT)
    .eq("brokerage_id", profile.brokerage_id)
    .eq("scope", scope)
    .eq("metric_type", metricType)
    .eq("period_label", periodLabel)
    .order("rank_position", { ascending: true })

  if (scope === "team") {
    if (!viewerAgent?.team_id) {
      return {
        ok: false,
        ...blank,
        brokerageId: profile.brokerage_id,
        currentAgentId,
        error: "You are not on a team yet, so there is no team board to show.",
      }
    }
    query = query.eq("team_id", viewerAgent.team_id)
  }

  if (options.limit) query = query.limit(options.limit)
  if (options.offset) query = query.range(options.offset, options.offset + (options.limit || 20) - 1)

  const { data, error } = await query
  if (error) {
    return { ok: false, ...blank, brokerageId: profile.brokerage_id, currentAgentId, error: `Could not load the leaderboard: ${error.message}` }
  }

  return {
    ok: true,
    rankings: ((data ?? []) as any[]).map((r) => toLeaderboardRow(r, currentAgentId)),
    currentAgentId,
    brokerageId: profile.brokerage_id,
    scope,
    metricType,
    periodLabel,
  }
}

// ─── GET TOP 5 WIDGET ─────────────────────────────────────────────────────────
/**
 * The academy's "Your Ranking" card. It asked for scope 'agent' — a value the
 * populator has never written and the scope CHECK no longer admits — so it was
 * empty by construction. It asks for the BROKERAGE points board for the current
 * month, which is the board the full page opens on, and now also returns
 * `current_agent`, which the widget has always had markup for and never data.
 */
export async function getLeaderboardWidget(params: { agentId: string }) {
  const empty = { rankings: [] as any[], currentAgentId: null as string | null, current_agent: null as any }
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return empty

  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("id, brokerage_id, gamification_points")
    .eq("id", params.agentId)
    .maybeSingle()
  if (agentError) {
    console.error(`[getLeaderboardWidget] agent read refused: ${agentError.message}`)
    return empty
  }
  if (!agent?.brokerage_id) return empty

  const periodLabel = monthLabel(new Date())

  const { data: rankings, error } = await supabase
    .from("leaderboard_rankings")
    .select(RANKING_SELECT)
    .eq("brokerage_id", agent.brokerage_id)
    .eq("scope", "brokerage")
    .eq("metric_type", "points")
    .eq("period_label", periodLabel)
    .order("rank_position", { ascending: true })
    .limit(5)

  if (error) {
    console.error(`[getLeaderboardWidget] leaderboard read refused: ${error.message}`)
    return empty
  }

  // The viewer's own line may be outside the top 5 — read it on its own so the
  // "you are #N" row can render.
  const { data: mine } = await supabase
    .from("leaderboard_rankings")
    .select("rank_position, metric_value")
    .eq("brokerage_id", agent.brokerage_id)
    .eq("scope", "brokerage")
    .eq("metric_type", "points")
    .eq("period_label", periodLabel)
    .eq("agent_id", params.agentId)
    .maybeSingle()

  const points = Number(agent.gamification_points) || 0

  return {
    rankings: rankings ?? [],
    currentAgentId: params.agentId,
    current_agent: mine
      ? { rank: Number(mine.rank_position) || 0, points: Number(mine.metric_value) || 0, tier: tierLabelForPoints(points) }
      : null,
  }
}
