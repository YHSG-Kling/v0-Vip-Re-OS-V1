"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

// ============================================================================
// Types
// ============================================================================

export type ActivityType = "listing" | "buyer" | "closed" | "lead" | "all"

export interface HeatmapFilters {
  agentId?: string
  teamId?: string
  activityTypes: ActivityType[]
  dateRange: "7d" | "30d" | "90d" | "custom"
  startDate?: string
  endDate?: string
  revenueWeighted: boolean
}

export interface HeatmapSnapshot {
  id: string
  agent_id: string
  agent_name: string
  profile_photo_url: string | null
  zip_code: string
  city: string
  lat: number
  lng: number
  activity_type: string
  activity_count: number
  revenue_amount: number | null
  snapshot_date: string
}

export interface ZipCodeActivity {
  zip_code: string
  city: string
  lat: number
  lng: number
  total_activity: number
  total_revenue: number
  activity_breakdown: Record<string, number>
}

export interface AgentActivitySummary {
  agent_id: string
  agent_name: string
  profile_photo_url: string | null
  active_zips: number
  listings: number
  buyers: number
  closed: number
  leads: number
  total_revenue: number
  prior_period_revenue: number
  change_pct: number
}

export interface OpportunityZone {
  zip_code: string
  city: string
  lat: number
  lng: number
  buyer_count: number
  listing_count: number
  opportunity_score: number
  reason: string
}

// ============================================================================
// Server Actions
// ============================================================================

/**
 * Get heatmap snapshots with filters
 */
export async function getHeatmapSnapshots(
  filters: HeatmapFilters
): Promise<{ snapshots: HeatmapSnapshot[]; error: string | null }> {
  const supabase = await createClient()
  const { brokerageId, agentId: currentAgentId } = await getAgentContext()

  // Calculate date range
  const now = new Date()
  let startDate: Date
  let endDate = now

  if (filters.dateRange === "custom" && filters.startDate && filters.endDate) {
    startDate = new Date(filters.startDate)
    endDate = new Date(filters.endDate)
  } else {
    const days = filters.dateRange === "7d" ? 7 : filters.dateRange === "30d" ? 30 : 90
    startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  }

  // Check user role for filtering
  const { data: user } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", (await supabase.auth.getUser()).data.user?.id)
    .single()

  const isPrivileged = isAdminOrBroker({ user_type: user?.user_type || "" })

  let query = supabase
    .from("team_heatmap_snapshots")
    .select(`
      id,
      agent_id,
      zip_code,
      city,
      lat,
      lng,
      activity_type,
      activity_count,
      revenue_amount,
      snapshot_date,
      agents!inner (
        id,
        user_id,
        users!inner (
          first_name,
          last_name
        )
      )
    `)
    .eq("brokerage_id", brokerageId)
    .gte("snapshot_date", startDate.toISOString().split("T")[0])
    .lte("snapshot_date", endDate.toISOString().split("T")[0])

  // Activity type filter
  if (!filters.activityTypes.includes("all") && filters.activityTypes.length > 0) {
    query = query.in("activity_type", filters.activityTypes)
  }

  // Agent filter - agents can only see their own data unless privileged
  if (!isPrivileged && currentAgentId) {
    query = query.eq("agent_id", currentAgentId)
  } else if (filters.agentId) {
    query = query.eq("agent_id", filters.agentId)
  }

  // Team filter (broker only)
  if (filters.teamId && isPrivileged) {
    query = query.eq("agents.team_id", filters.teamId)
  }

  const { data, error } = await query

  if (error) {
    console.error("Error fetching heatmap snapshots:", error)
    return { snapshots: [], error: error.message }
  }

  const snapshots: HeatmapSnapshot[] = (data || []).map((row: any) => ({
    id: row.id,
    agent_id: row.agent_id,
    agent_name: row.agents?.users
      ? `${row.agents.users.first_name} ${row.agents.users.last_name}`
      : "Unknown Agent",
    profile_photo_url: null,
    zip_code: row.zip_code,
    city: row.city || "",
    lat: row.lat,
    lng: row.lng,
    activity_type: row.activity_type,
    activity_count: row.activity_count,
    revenue_amount: row.revenue_amount,
    snapshot_date: row.snapshot_date,
  }))

  return { snapshots, error: null }
}

/**
 * Get top active zip codes
 */
export async function getTopZipCodes(
  filters: HeatmapFilters,
  limit: number = 5
): Promise<{ zipCodes: ZipCodeActivity[]; error: string | null }> {
  const { snapshots, error } = await getHeatmapSnapshots(filters)

  if (error) {
    return { zipCodes: [], error }
  }

  // Aggregate by zip code
  const zipMap = new Map<string, ZipCodeActivity>()

  for (const s of snapshots) {
    const existing = zipMap.get(s.zip_code)
    if (existing) {
      existing.total_activity += s.activity_count
      existing.total_revenue += s.revenue_amount || 0
      existing.activity_breakdown[s.activity_type] =
        (existing.activity_breakdown[s.activity_type] || 0) + s.activity_count
    } else {
      zipMap.set(s.zip_code, {
        zip_code: s.zip_code,
        city: s.city,
        lat: s.lat,
        lng: s.lng,
        total_activity: s.activity_count,
        total_revenue: s.revenue_amount || 0,
        activity_breakdown: { [s.activity_type]: s.activity_count },
      })
    }
  }

  const sorted = Array.from(zipMap.values())
    .sort((a, b) => b.total_activity - a.total_activity)
    .slice(0, limit)

  return { zipCodes: sorted, error: null }
}

/**
 * Get opportunity zones (high buyer preference, low listings)
 */
export async function getOpportunityZones(): Promise<{
  zones: OpportunityZone[]
  error: string | null
}> {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  // Get buyer contacts by zip
  const { data: buyers, error: buyerError } = await supabase
    .from("contacts")
    .select("id, zip_code:property_interests(zip_codes)")
    .eq("brokerage_id", brokerageId)
    .eq("contact_type", "buyer")

  if (buyerError) {
    return { zones: [], error: buyerError.message }
  }

  // Get active listings by zip
  const { data: listings, error: listingError } = await supabase
    .from("listings")
    .select("id, zip")
    .eq("brokerage_id", brokerageId)
    .eq("status", "active")

  if (listingError) {
    return { zones: [], error: listingError.message }
  }

  // Count buyers per zip
  const buyerZipCounts = new Map<string, number>()
  for (const b of buyers || []) {
    const interests = b.zip_code as any[]
    if (interests) {
      for (const i of interests) {
        if (i.zip_codes) {
          for (const z of i.zip_codes) {
            buyerZipCounts.set(z, (buyerZipCounts.get(z) || 0) + 1)
          }
        }
      }
    }
  }

  // Count listings per zip
  const listingZipCounts = new Map<string, number>()
  for (const l of listings || []) {
    if (l.zip) {
      listingZipCounts.set(l.zip, (listingZipCounts.get(l.zip) || 0) + 1)
    }
  }

  // Find opportunity zones
  const zones: OpportunityZone[] = []
  for (const [zip, buyerCount] of buyerZipCounts.entries()) {
    const listingCount = listingZipCounts.get(zip) || 0
    if (buyerCount >= 3 && listingCount < 2) {
      zones.push({
        zip_code: zip,
        city: "",
        lat: 0,
        lng: 0,
        buyer_count: buyerCount,
        listing_count: listingCount,
        opportunity_score: buyerCount / Math.max(listingCount, 1),
        reason: `${buyerCount} buyers interested, only ${listingCount} active listings`,
      })
    }
  }

  return {
    zones: zones.sort((a, b) => b.opportunity_score - a.opportunity_score).slice(0, 10),
    error: null,
  }
}

/**
 * Get territory gaps (no recent activity)
 */
export async function getTerritoryGaps(): Promise<{
  gaps: string[]
  error: string | null
}> {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  // Get all zip codes from market_data
  const { data: marketZips, error: marketError } = await supabase
    .from("market_data")
    .select("zip_code")
    .eq("brokerage_id", brokerageId)

  if (marketError) {
    return { gaps: [], error: marketError.message }
  }

  // Get recent activity zips (last 90 days)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 90)

  const { data: activeZips, error: activeError } = await supabase
    .from("team_heatmap_snapshots")
    .select("zip_code")
    .eq("brokerage_id", brokerageId)
    .gte("snapshot_date", cutoff.toISOString().split("T")[0])

  if (activeError) {
    return { gaps: [], error: activeError.message }
  }

  const activeSet = new Set((activeZips || []).map((a) => a.zip_code))
  const gaps = (marketZips || [])
    .map((m) => m.zip_code)
    .filter((z) => z && !activeSet.has(z))
    .slice(0, 10)

  return { gaps, error: null }
}

/**
 * Get agent activity summary
 */
export async function getAgentActivitySummary(
  filters: HeatmapFilters
): Promise<{ agents: AgentActivitySummary[]; error: string | null }> {
  const { snapshots, error } = await getHeatmapSnapshots(filters)

  if (error) {
    return { agents: [], error }
  }

  // Calculate prior period for comparison
  const priorFilters = { ...filters }
  const days = filters.dateRange === "7d" ? 7 : filters.dateRange === "30d" ? 30 : 90
  const priorStart = new Date()
  priorStart.setDate(priorStart.getDate() - days * 2)
  const priorEnd = new Date()
  priorEnd.setDate(priorEnd.getDate() - days)

  priorFilters.dateRange = "custom"
  priorFilters.startDate = priorStart.toISOString().split("T")[0]
  priorFilters.endDate = priorEnd.toISOString().split("T")[0]

  const { snapshots: priorSnapshots } = await getHeatmapSnapshots(priorFilters)

  // Aggregate current period
  const agentMap = new Map<
    string,
    {
      agent_id: string
      agent_name: string
      profile_photo_url: string | null
      zips: Set<string>
      listings: number
      buyers: number
      closed: number
      leads: number
      revenue: number
    }
  >()

  for (const s of snapshots) {
    const existing = agentMap.get(s.agent_id)
    if (existing) {
      existing.zips.add(s.zip_code)
      if (s.activity_type === "listing") existing.listings += s.activity_count
      if (s.activity_type === "buyer") existing.buyers += s.activity_count
      if (s.activity_type === "closed") existing.closed += s.activity_count
      if (s.activity_type === "lead") existing.leads += s.activity_count
      existing.revenue += s.revenue_amount || 0
    } else {
      agentMap.set(s.agent_id, {
        agent_id: s.agent_id,
        agent_name: s.agent_name,
        profile_photo_url: s.profile_photo_url,
        zips: new Set([s.zip_code]),
        listings: s.activity_type === "listing" ? s.activity_count : 0,
        buyers: s.activity_type === "buyer" ? s.activity_count : 0,
        closed: s.activity_type === "closed" ? s.activity_count : 0,
        leads: s.activity_type === "lead" ? s.activity_count : 0,
        revenue: s.revenue_amount || 0,
      })
    }
  }

  // Aggregate prior period revenue
  const priorRevenueMap = new Map<string, number>()
  for (const s of priorSnapshots) {
    priorRevenueMap.set(
      s.agent_id,
      (priorRevenueMap.get(s.agent_id) || 0) + (s.revenue_amount || 0)
    )
  }

  const agents: AgentActivitySummary[] = Array.from(agentMap.values()).map((a) => {
    const priorRevenue = priorRevenueMap.get(a.agent_id) || 0
    const changePct =
      priorRevenue > 0 ? ((a.revenue - priorRevenue) / priorRevenue) * 100 : 0

    return {
      agent_id: a.agent_id,
      agent_name: a.agent_name,
      profile_photo_url: a.profile_photo_url,
      active_zips: a.zips.size,
      listings: a.listings,
      buyers: a.buyers,
      closed: a.closed,
      leads: a.leads,
      total_revenue: a.revenue,
      prior_period_revenue: priorRevenue,
      change_pct: changePct,
    }
  })

  return {
    agents: agents.sort((a, b) => b.total_revenue - a.total_revenue),
    error: null,
  }
}

/**
 * Get agents list for filter dropdown
 */
export async function getAgentsForFilter(): Promise<{
  agents: { id: string; name: string }[]
  error: string | null
}> {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  const { data: user } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", (await supabase.auth.getUser()).data.user?.id)
    .single()

  const isPrivileged = isAdminOrBroker({ user_type: user?.user_type || "" })

  if (!isPrivileged) {
    return { agents: [], error: null }
  }

  const { data, error } = await supabase
    .from("agents")
    .select(`
      id,
      user_id,
      users!inner (
        first_name,
        last_name
      )
    `)
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)

  if (error) {
    return { agents: [], error: error.message }
  }

  const agents = (data || []).map((a: any) => ({
    id: a.id,
    name: a.users ? `${a.users.first_name} ${a.users.last_name}` : "Unknown",
  }))

  return { agents, error: null }
}

/**
 * Get teams list for filter dropdown (broker only)
 */
export async function getTeamsForFilter(): Promise<{
  teams: { id: string; name: string }[]
  error: string | null
}> {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  const { data: user } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", (await supabase.auth.getUser()).data.user?.id)
    .single()

  if (!isAdminOrBroker({ user_type: user?.user_type || "" })) {
    return { teams: [], error: null }
  }

  const { data, error } = await supabase
    .from("teams")
    .select("id, name")
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)

  if (error) {
    return { teams: [], error: error.message }
  }

  return { teams: data || [], error: null }
}
