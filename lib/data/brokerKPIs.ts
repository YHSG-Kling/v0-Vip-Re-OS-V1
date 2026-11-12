import { createClient } from "@/lib/supabase/server"

export interface BrokerKPIData {
  newLeads7Days: number
  appointmentsSet: number
  signedListings: number
  closings: number
  fallThroughRate: number
  gci: number
  netMargin: number
}

export interface AgentPerformance {
  agentId: string
  agentName: string
  newLeads: number
  speedToLead: number // in minutes
  activeDeals: number
  closedDeals: number
  avgResponseTime: number // in minutes
  gci: number
}

export async function getBrokerKPIs(brokerageId: string, timeRange = "7d"): Promise<BrokerKPIData> {
  const supabase = await createClient()

  // Calculate date range
  const now = new Date()
  const startDate = new Date()
  if (timeRange === "7d") startDate.setDate(now.getDate() - 7)
  else if (timeRange === "30d") startDate.setDate(now.getDate() - 30)
  else if (timeRange === "90d") startDate.setDate(now.getDate() - 90)

  // Query new leads
  const { data: leads, error: leadsError } = await supabase
    .from("contacts")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .gte("created_at", startDate.toISOString())

  // Appointments KPI — UNRESOLVED SOURCE (2026-08-31, honest 0 instead of a
  // blind query). This counted contacts with status='appointment_booked', a
  // value NO writer has ever stored on contacts.status (its only would-be
  // writer, the aiMappingService import path, has zero call sites) and one the
  // m587 CHECK does not admit — so the count was permanently 0 while reading as
  // a live measurement. Appointment facts live elsewhere (a live `appointments`
  // table exists but no code queries it and it is absent from
  // scripts/schema-snapshot.ts, so a query against unverified columns would be
  // the schema-drift defect §2 exists to stop). Whoever wires this KPI up must
  // pick the real source; until then the 0 says what it is.
  const appointments: { id: string }[] = []

  // Query signed listings
  const { data: signedListings, error: signedError } = await supabase
    .from("listings")
    .select("id")
    .eq("brokerage_id", brokerageId)
    // "signed" is a LIFECYCLE stage, not a status — listings.status has no
    // signed_agreement, so this KPI was permanently 0.
    .eq("lifecycle_stage", "LISTING_AGREEMENT_SIGNED")
    .gte("created_at", startDate.toISOString())

  // Query closings (sold listings)
  const { data: closings, error: closingsError } = await supabase
    .from("listings")
    .select("id, list_price, commission_rate")
    .eq("brokerage_id", brokerageId)
    .eq("status", "sold")
    .gte("updated_at", startDate.toISOString())

  // Query fall-through (contingent or pending that went back to active)
  const { data: fallThroughs, error: fallThroughError } = await supabase
    .from("listings")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .in("status", ["pending"])  // "contingent" is not a listings status
    .gte("updated_at", startDate.toISOString())

  // Calculate GCI from closings
  const gci =
    closings?.reduce((sum: number, listing: any) => {
      return sum + listing.list_price * (listing.commission_rate || 0.03)
    }, 0) || 0

  // Estimate net margin (GCI - broker split - expenses, typically 30-40% net)
  const netMargin = gci * 0.35

  return {
    newLeads7Days: leads?.length || 0,
    appointmentsSet: appointments?.length || 0,
    signedListings: signedListings?.length || 0,
    closings: closings?.length || 0,
    fallThroughRate:
      fallThroughs && closings ? (fallThroughs.length / (closings.length + fallThroughs.length)) * 100 : 0,
    gci: Math.round(gci),
    netMargin: Math.round(netMargin),
  }
}

export async function getAgentPerformance(brokerageId: string, timeRange = "30d"): Promise<AgentPerformance[]> {
  const supabase = await createClient()

  // Calculate date range
  const now = new Date()
  const startDate = new Date()
  if (timeRange === "7d") startDate.setDate(now.getDate() - 7)
  else if (timeRange === "30d") startDate.setDate(now.getDate() - 30)
  else if (timeRange === "90d") startDate.setDate(now.getDate() - 90)

  // Get all agents in the brokerage — agents table replaced user_brokerage_roles —
  // user_brokerage_roles was a writer-less legacy twin (burn-down round 4 repoint).
  // contacts.agent_id / listings.agent_id key on agents.id, so the canonical agents
  // roster (the same pattern other broker dashboards use) is the clean 1:1 here.
  const { data: agents, error: agentsError } = await supabase
    .from("agents")
    .select("id, user_id, users(first_name, last_name, email)")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)

  if (agentsError || !agents) {
    console.error("Error fetching agents:", agentsError)
    return []
  }

  // For each agent, calculate performance metrics
  const performance: AgentPerformance[] = []

  for (const agent of agents) {
    const agentId = agent.id

    // New leads
    const { data: leads } = await supabase
      .from("contacts")
      .select("id, created_at")
      .eq("agent_id", agentId)
      .gte("created_at", startDate.toISOString())

    // Active deals
    const { data: activeDeals } = await supabase
      .from("listings")
      .select("id")
      .eq("agent_id", agentId)
      // Of the four this used, only "pending" exists — the agent's active-deal
      // count was silently just their pending listings.
      .in("status", ["active", "pending"])

    // Closed deals
    const { data: closedDeals } = await supabase
      .from("listings")
      .select("id, list_price, commission_rate")
      .eq("agent_id", agentId)
      .eq("status", "sold")
      .gte("updated_at", startDate.toISOString())

    // Calculate speed-to-lead (average time from lead created to first contact)
    const speedToLead = leads?.length
      ? leads.reduce((sum: number, _lead: any) => sum + 15, 0) / leads.length
      : // Mock: 15 min average
        0

    // Calculate avg response time (mock for now)
    const avgResponseTime = 12 // minutes

    // Calculate GCI
    const gci =
      closedDeals?.reduce((sum: number, listing: any) => {
        return sum + listing.list_price * (listing.commission_rate || 0.03)
      }, 0) || 0

    const agentUser = Array.isArray((agent as any).users) ? (agent as any).users[0] : (agent as any).users
    const agentName =
      [agentUser?.first_name, agentUser?.last_name].filter(Boolean).join(" ") ||
      agentUser?.email?.split("@")[0] ||
      "Unknown Agent"

    performance.push({
      agentId,
      agentName,
      newLeads: leads?.length || 0,
      speedToLead,
      activeDeals: activeDeals?.length || 0,
      closedDeals: closedDeals?.length || 0,
      avgResponseTime,
      gci: Math.round(gci),
    })
  }

  return performance.sort((a, b) => b.gci - a.gci)
}
