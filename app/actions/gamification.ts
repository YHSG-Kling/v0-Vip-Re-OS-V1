"use server"

// app/actions/gamification.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE AGENT-FACING GAMIFICATION READS + THE BADGE AWARDER.
//
// "use server" IS NEW AND IT IS NOT COSMETIC. This module is imported directly by
// three CLIENT components (app/dashboard/motivation/motivation-client.tsx,
// app/academy/components/os/embedded-leaderboard-widget.tsx, and
// app/lib/gamification/award-on-action.ts's callers) while itself importing
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
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"
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
  }
}

// ─── AWARD BADGE ──────────────────────────────────────────────────────────────
// NOT EXPORTED, deliberately. This file carries "use server", so every export is
// a public HTTP endpoint that receives whatever a caller POSTs — and this
// function takes the agent and the badge as ARGUMENTS and writes the award. As
// an export it was a badge-forging endpoint: any signed-in user could award any
// badge, including the top rung, to any agent in their own brokerage (RLS scopes
// the tenant but does not ask whether the badge was EARNED). That is the same
// class m484 just closed on agent_points_log, one table over, on a board the
// owner asked to be competitive.
//
// The only legitimate awarder is checkAndAwardBadges below, which awards against
// a points threshold the agent actually reached. Module-private is what makes
// that the ONLY path.
async function awardBadge(data: {
  agentId: string
  badgeId: string
  reason: string
}) {
  const supabase = await createClient()

  // Check if agent already has this badge
  const { data: existing } = await supabase
    .from("agent_badges")
    .select("id")
    .eq("agent_id", data.agentId)
    .eq("badge_id", data.badgeId)
    .maybeSingle()

  if (existing) {
    return { alreadyAwarded: true }
  }

  // Tenant for the badge row comes from the AGENT it is awarded to
  // (agents.brokerage_id) — agent_id is an agents.id, not a tenant, and the
  // two id spaces are disjoint. An unstamped row is readable AND writable by
  // every brokerage under the `brokerage_id IS NULL OR …` policy, so refuse
  // rather than write one. `user_id` comes along because the agent is TOLD.
  const { data: agentData, error: agentErr } = await supabase
    .from("agents")
    .select("brokerage_id, user_id")
    .eq("id", data.agentId)
    .single()
  if (agentErr) throw agentErr
  if (!agentData?.brokerage_id) {
    throw new Error(`awardBadge: no brokerage resolvable from agent ${data.agentId}`)
  }

  const { data: newBadge, error } = await supabase
    .from("agent_badges")
    .insert({
      brokerage_id: agentData.brokerage_id,
      agent_id: data.agentId,
      badge_id: data.badgeId,
      awarded_reason: data.reason,
      awarded_at: new Date().toISOString(),
    })
    .select(`
      id,
      badge_id,
      awarded_at,
      awarded_reason,
      gamification_badges:badge_id(id, badge_name, badge_description, badge_icon, badge_tier)
    `)
    .single()

  if (error) throw error

  const def = (newBadge.gamification_badges as any)
  const badgeName = (Array.isArray(def) ? def[0]?.badge_name : def?.badge_name) ?? "a badge"
  const badgeTier = (Array.isArray(def) ? def[0]?.badge_tier : def?.badge_tier) ?? null

  // Emit kernel event — brokerage_id resolved above, from the agent record.
  // Audit row + reactor (notification_rules keyed on this event now fire).
  await emitKernelEvent({
    brokerageId: agentData.brokerage_id,
    event: KernelEvent.GAMIFICATION_BADGE_AWARDED,
    entityType: "agent_badge",
    entityId: newBadge.id,
    agentId: data.agentId,
    metadata: {
      agent_id: data.agentId,
      badge_id: data.badgeId,
      badge_name: badgeName,
      badge_tier: badgeTier,
      reason: data.reason,
    },
  })

  // THE EVENT NOW HAS A CONSUMER, AND IT IS THE PERSON IT IS ABOUT.
  // GAMIFICATION_BADGE_AWARDED had been emitted since the rail existed with
  // nothing subscribed to it, so an agent could earn a badge and never find out
  // unless they happened to open the Motivation page afterwards. A badge nobody
  // is told about is not a reward. Best-effort: the award itself is committed.
  if (agentData.user_id) {
    const { error: notifyErr } = await supabase.from("notifications").insert({
      user_id: agentData.user_id,
      brokerage_id: agentData.brokerage_id,
      type: "gamification_badge_awarded",
      title: `Badge earned: ${badgeName}`,
      body: data.reason,
      entity_type: "agent_badge",
      entity_id: newBadge.id,
      priority: "low",
      is_read: false,
    })
    if (notifyErr) {
      console.error(`[awardBadge] badge ${newBadge.id} awarded but the agent was not notified: ${notifyErr.message}`)
    }
  }

  return { alreadyAwarded: false, badge: newBadge }
}

// ─── CHECK AND AWARD BADGES ───────────────────────────────────────────────────
export async function checkAndAwardBadges(agentId: string, currentPoints: number) {
  const supabase = await createClient()

  // Every active badge this agent's total has reached. RLS on gamification_badges
  // is (brokerage_id IS NULL OR brokerage_id = mine), so this returns the platform
  // defaults plus whatever this brokerage added on top — and nothing else.
  const { data: eligibleBadges, error: badgesError } = await supabase
    .from("gamification_badges")
    .select("id, badge_name, badge_tier, required_points")
    .eq("is_active", true)
    .lte("required_points", currentPoints)
    .order("required_points", { ascending: true })

  if (badgesError) throw badgesError

  const awardedBadges = []

  for (const badge of eligibleBadges || []) {
    const result = await awardBadge({
      agentId,
      badgeId: badge.id,
      reason: `Reached ${Number(badge.required_points).toLocaleString()} points`,
    })

    if (!result.alreadyAwarded && result.badge) {
      awardedBadges.push({
        id: (result.badge as any).id,
        name: badge.badge_name,
        tier: badge.badge_tier,
        requiredPoints: Number(badge.required_points) || 0,
      })
    }
  }

  return awardedBadges
}

// ─── ADD POINTS ───────────────────────────────────────────────────────────────
/**
 * ONE ATOMIC AWARD. The increment and the ledger row happen inside
 * public.award_agent_points() (m484), in one transaction, with the tenant derived
 * from the agents row. What stood here was read-modify-write — SELECT the total,
 * add, UPDATE it back, then a best-effort ledger insert — so two awards racing
 * each other kept only one, and agents.gamification_points could drift from
 * SUM(agent_points_log.points) forever with nothing to reconcile them.
 */
export async function addPoints(agentId: string, pointType: string) {
  const { POINT_VALUES, awardAgentPoints } = await import("@/lib/gamification/award-points")
  const pointsToAdd = (POINT_VALUES as Record<string, number>)[pointType]
  if (!pointsToAdd) {
    return { ok: false as const, error: `"${pointType}" is not a point value this platform awards.` }
  }

  const supabase = await createClient()
  const awarded = await awardAgentPoints(supabase, {
    agentId,
    points: pointsToAdd,
    reason: pointType,
    referenceType: "gamification_event",
  })
  if (!awarded.ok) return { ok: false as const, error: awarded.error }

  // Badges are checked against the total the DATABASE now holds, not against the
  // caller's own arithmetic.
  const newBadges = await checkAndAwardBadges(agentId, awarded.newTotal)

  return {
    ok: true as const,
    pointsAdded: awarded.pointsAdded,
    newPoints: awarded.newTotal,
    previousPoints: awarded.newTotal - awarded.pointsAdded,
    newBadgesAwarded: newBadges,
  }
}

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
