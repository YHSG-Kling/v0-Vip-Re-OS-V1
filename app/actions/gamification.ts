import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"

// ─── POINT VALUES ─────────────────────────────────────────────────────────────
export const POINT_VALUES = {
  LISTING_CLOSED: 100,
  OFFER_SUBMITTED: 50,
  REFERRAL_CREATED: 75,
  VENDOR_REVIEW_WRITTEN: 25,
  ONBOARDING_STEP_COMPLETED: 10,
  CAP_HIT: 200,
} as const

// ─── GET AGENT BADGES ─────────────────────────────────────────────────────────
export async function getAgentBadges(agentId: string) {
  const supabase = await createClient()

  const { data: earnedBadges, error: earnedError } = await supabase
    .from("agent_badges")
    .select(`
      id,
      badge_id,
      awarded_at,
      awarded_reason,
      gamification_badges:badge_id(
        id,
        badge_name,
        badge_description,
        badge_icon,
        badge_tier,
        required_points,
        trigger_event
      )
    `)
    .eq("agent_id", agentId)
    .order("awarded_at", { ascending: false })

  if (earnedError) throw earnedError

  const { data: allBadges, error: allError } = await supabase
    .from("gamification_badges")
    .select("*")
    .eq("is_active", true)
    .order("required_points", { ascending: true })

  if (allError) throw allError

  const earnedBadgeIds = new Set(earnedBadges?.map(eb => eb.badge_id))

  return {
    earned: earnedBadges || [],
    all: allBadges || [],
    earnedBadgeIds,
  }
}

// ─── GET AGENT POINTS AND TIER ────────────────────────────────────────────────
export async function getAgentPointsAndTier(agentId: string) {
  const supabase = await createClient()

  const { data: agent, error } = await supabase
    .from("agents")
    .select("id, first_name, last_name, gamification_points")
    .eq("id", agentId)
    .single()

  if (error) throw error

  const points = agent?.gamification_points || 0

  // Determine current tier based on points
  let currentTier = "none"
  let nextTier = "Bronze"
  let pointsToNextTier = 500

  if (points >= 25000) {
    currentTier = "Platinum"
    nextTier = "Diamond"
    pointsToNextTier = 0 // Diamond is custom/broker-assigned
  } else if (points >= 10000) {
    currentTier = "Gold"
    nextTier = "Platinum"
    pointsToNextTier = 25000 - points
  } else if (points >= 2500) {
    currentTier = "Silver"
    nextTier = "Gold"
    pointsToNextTier = 10000 - points
  } else if (points >= 500) {
    currentTier = "Bronze"
    nextTier = "Silver"
    pointsToNextTier = 2500 - points
  } else {
    pointsToNextTier = 500 - points
  }

  return {
    agentId: agent?.id,
    agentName: `${agent?.first_name || ""} ${agent?.last_name || ""}`.trim(),
    points,
    currentTier,
    nextTier,
    pointsToNextTier,
  }
}

// ─── AWARD BADGE ──────────────────────────────────────────────────────────────
export async function awardBadge(data: {
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

  // Insert new badge
  const { data: newBadge, error } = await supabase
    .from("agent_badges")
    .insert({
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
      gamification_badges:badge_id(
        id,
        badge_name,
        badge_description,
        badge_icon,
        badge_tier
      )
    `)
    .single()

  if (error) throw error

  // Emit kernel event - get brokerage_id from agent
  const { data: agentData } = await supabase.from("agents").select("brokerage_id").eq("id", data.agentId).single()
  await supabase.from("lifecycle_events").insert({
    brokerage_id: agentData?.brokerage_id,
    event_type: KernelEvent.GAMIFICATION_BADGE_AWARDED,
    entity_type: "agent_badge",
    entity_id: newBadge.id,
    metadata: {
      agent_id: data.agentId,
      badge_id: data.badgeId,
      badge_name: newBadge.gamification_badges?.badge_name,
      badge_tier: newBadge.gamification_badges?.badge_tier,
      reason: data.reason,
    },
    created_at: new Date().toISOString(),
  })

  return { alreadyAwarded: false, badge: newBadge }
}

// ─── CHECK AND AWARD BADGES ───────────────────────────────────────────────────
export async function checkAndAwardBadges(agentId: string, currentPoints: number) {
  const supabase = await createClient()

  // Get all active badges where required_points <= currentPoints
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
      reason: `Reached ${badge.required_points} points`,
    })

    if (!result.alreadyAwarded && result.badge) {
      awardedBadges.push(result.badge)
    }
  }

  return awardedBadges
}

// ─── ADD POINTS ───────────────────────────────────────────────────────────────
export async function addPoints(agentId: string, pointType: keyof typeof POINT_VALUES) {
  const supabase = await createClient()
  const pointsToAdd = POINT_VALUES[pointType]

  // Get current points
  const { data: agent, error: getError } = await supabase
    .from("agents")
    .select("gamification_points")
    .eq("id", agentId)
    .single()

  if (getError) throw getError

  const currentPoints = agent?.gamification_points || 0
  const newPoints = currentPoints + pointsToAdd

  // Update points
  const { error: updateError } = await supabase
    .from("agents")
    .update({ gamification_points: newPoints })
    .eq("id", agentId)

  if (updateError) throw updateError

  // Check and award any new badges
  const newBadges = await checkAndAwardBadges(agentId, newPoints)

  return {
    previousPoints: currentPoints,
    pointsAdded: pointsToAdd,
    newPoints,
    newBadgesAwarded: newBadges,
  }
}

// ─── GET LEADERBOARD ──────────────────────────────────────────────────────────
export async function getLeaderboard(options: {
  scope: "agent" | "team" | "brokerage"
  metricType: "points" | "revenue" | "transactions" | "referrals"
  periodLabel: string
  limit?: number
  offset?: number
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  const query = supabase
    .from("leaderboard_rankings")
    .select(`
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
      agents:agent_id(id, first_name, last_name, gamification_points, profile_image_url)
    `)
    .eq("brokerage_id", profile.brokerage_id)
    .eq("scope", options.scope)
    .eq("metric_type", options.metricType)
    .eq("period_label", options.periodLabel)
    .order("rank_position", { ascending: true })

  if (options.limit) {
    query.limit(options.limit)
  }

  if (options.offset) {
    query.range(options.offset, options.offset + (options.limit || 20) - 1)
  }

  const { data, error } = await query

  if (error) throw error

  // Get current user's agent ID to highlight their row
  const { data: agentData } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  return {
    rankings: data || [],
    currentAgentId: agentData?.id,
    brokerageId: profile.brokerage_id ?? "", // brokerage_id guarded above
  }
}

// ─── GET TOP 5 WIDGET ─────────────────────────────────────────────────────────
export async function getLeaderboardWidget(params: { agentId: string }) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { rankings: [], currentAgentId: null }

  // Get agent's brokerage — validate agent exists and belongs to user's organization
  const { data: agent } = await supabase
    .from("agents")
    .select("id, brokerage_id, user_id")
    .eq("id", params.agentId)
    .maybeSingle()

  if (!agent?.brokerage_id) return { rankings: [], currentAgentId: null }

  // Get current month period label
  const now = new Date()
  const periodLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`

  const { data: rankings, error } = await supabase
    .from("leaderboard_rankings")
    .select(`
      id,
      rank_position,
      metric_type,
      metric_value,
      agent_id,
      agents:agent_id(id, first_name, last_name, gamification_points, profile_image_url)
    `)
    .eq("brokerage_id", agent.brokerage_id)
    .eq("scope", "agent")
    .eq("metric_type", "points")
    .eq("period_label", periodLabel)
    .order("rank_position", { ascending: true })
    .limit(5)

  if (error) throw error

  return {
    rankings: rankings || [],
    currentAgentId: params.agentId,
  }
}
