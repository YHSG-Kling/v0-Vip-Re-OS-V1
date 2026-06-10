import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(req: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(req.url)
  const period = url.searchParams.get("period") ?? "month"

  const now = new Date()
  let periodStart: Date
  if (period === "quarter") {
    const q = Math.floor(now.getMonth() / 3)
    periodStart = new Date(now.getFullYear(), q * 3, 1)
  } else if (period === "year") {
    periodStart = new Date(now.getFullYear(), 0, 1)
  } else {
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1)
  }
  const startIso = periodStart.toISOString()

  const { data: agent } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user.id)
    .maybeSingle()

  const agentId = agent?.id ?? null
  const brokerageId = agent?.brokerage_id ?? null

  const [
    // Lead acquisition funnel
    leadsResult,
    qualifiedLeadsResult,
    assignedLeadsResult,
    convertedLeadsResult,

    // AI-ISA performance
    outreachResult,
    qualificationsResult,
    appointmentsResult,

    // Listing health
    activeListingsResult,
    listingsWithOffersResult,
    closedListingsResult,

    // Transaction health
    transactionsResult,

    // Marketing
    campaignResult,

    // Cross-domain stuck work
    stuckTxResult,
    staleLeadsResult,
    acceptedOffersNoTxResult,
  ] = await Promise.all([
    // Total leads in period
    brokerageId
      ? supabase
          .from("leads")
          .select("id, lead_stage, lead_score, source, created_at", { count: "exact" })
          .eq("brokerage_id", brokerageId)
          .gte("created_at", startIso)
      : Promise.resolve({ data: [], count: 0 }),

    // Qualified
    brokerageId
      ? supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .gte("created_at", startIso)
          .eq("lead_stage", "qualified")
      : Promise.resolve({ count: 0 }),

    // Assigned
    brokerageId
      ? supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .gte("created_at", startIso)
          .not("agent_id", "is", null)
      : Promise.resolve({ count: 0 }),

    // Converted
    brokerageId
      ? supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .gte("created_at", startIso)
          .eq("lead_stage", "converted")
      : Promise.resolve({ count: 0 }),

    // ISA outreach sent
    brokerageId
      ? supabase
          .from("isa_outreach_log")
          .select("id, channel, status, sent_at", { count: "exact" })
          .eq("brokerage_id", brokerageId)
          .gte("sent_at", startIso)
      : Promise.resolve({ data: [], count: 0 }),

    // ISA qualifications
    brokerageId
      ? supabase
          .from("ai_isa_qualifications")
          .select("id, qualification_result, qualified_at", { count: "exact" })
          .eq("brokerage_id", brokerageId)
          .gte("qualified_at", startIso)
      : Promise.resolve({ data: [], count: 0 }),

    // Appointments set
    brokerageId
      ? supabase
          .from("ai_isa_calls")
          .select("id, appointment_set, appointment_datetime", { count: "exact" })
          .eq("brokerage_id", brokerageId)
          .gte("created_at", startIso)
          .eq("appointment_set", true)
      : Promise.resolve({ data: [], count: 0 }),

    // Active listings
    brokerageId
      ? supabase
          .from("listings")
          .select("id, address, list_price, current_stage:lifecycle_stage, showing_count, listing_date", {
            count: "exact",
          })
          .eq("brokerage_id", brokerageId)
          .eq("status", "active")
      : Promise.resolve({ data: [], count: 0 }),

    // Listings with active offers
    brokerageId
      ? supabase
          .from("listings")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .in("lifecycle_stage", ["offer_received", "under_contract"])
      : Promise.resolve({ count: 0 }),

    // Closed listings in period
    brokerageId
      ? supabase
          .from("listings")
          .select("id, list_price, address", { count: "exact" })
          .eq("brokerage_id", brokerageId)
          .eq("status", "closed")
          .gte("updated_at", startIso)
      : Promise.resolve({ data: [], count: 0 }),

    // Transactions with health scores
    brokerageId
      ? supabase
          .from("transactions")
          .select("id, deal_name, property_address, status, stage, health_score, close_date")
          .eq("brokerage_id", brokerageId)
          .not("status", "in", "(closed,cancelled)")
          .order("health_score", { ascending: true })
          .limit(10)
      : Promise.resolve({ data: [] }),

    // Marketing spend and conversions
    brokerageId
      ? supabase
          .from("campaign_roi")
          .select("total_spend, total_leads, total_conversions, total_revenue, roi_percentage")
          .eq("brokerage_id", brokerageId)
      : Promise.resolve({ data: [] }),

    // Stuck transactions
    brokerageId
      ? supabase
          .from("transactions")
          .select("id, deal_name, property_address, stage, updated_at")
          .eq("brokerage_id", brokerageId)
          .not("status", "in", "(closed,cancelled)")
          .lte("updated_at", new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString())
          .limit(5)
      : Promise.resolve({ data: [] }),

    // Stale leads
    brokerageId
      ? supabase
          .from("leads")
          .select("id, first_name, last_name, lead_stage, created_at")
          .eq("brokerage_id", brokerageId)
          .eq("lead_stage", "qualified")
          .is("agent_id", null)
          .lte("updated_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
          .limit(5)
      : Promise.resolve({ data: [] }),

    // Accepted offers no tx
    brokerageId
      ? supabase
          .from("offers")
          .select("id, offer_price, updated_at, listing:listings(address)")
          .eq("brokerage_id", brokerageId)
          .eq("status", "accepted")
          .is("transaction_id", null)
          .limit(5)
      : Promise.resolve({ data: [] }),
  ])

  // Aggregate campaign ROI totals
  const campaignData = campaignResult.data ?? []
  const marketingTotals = {
    totalSpend: campaignData.reduce((s: number, r: any) => s + (r.total_spend ?? 0), 0),
    totalLeads: campaignData.reduce((s: number, r: any) => s + (r.total_leads ?? 0), 0),
    totalConversions: campaignData.reduce((s: number, r: any) => s + (r.total_conversions ?? 0), 0),
    totalRevenue: campaignData.reduce((s: number, r: any) => s + (r.total_revenue ?? 0), 0),
  }

  // Source breakdown for leads
  const leads = leadsResult.data ?? []
  const sourceMap: Record<string, number> = {}
  leads.forEach((l: any) => {
    const src = l.source ?? "unknown"
    sourceMap[src] = (sourceMap[src] ?? 0) + 1
  })
  const topSources = Object.entries(sourceMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([source, count]) => ({ source, count }))

  const outreach = outreachResult.data ?? []
  const channelMap: Record<string, number> = {}
  outreach.forEach((o: any) => {
    const ch = o.channel ?? "unknown"
    channelMap[ch] = (channelMap[ch] ?? 0) + 1
  })

  // At-risk transactions (health score < 50)
  const atRiskTransactions = (transactionsResult.data ?? []).filter(
    (t: any) => t.health_score !== null && t.health_score < 50
  )

  return NextResponse.json({
    period,
    // Lead funnel
    leadFunnel: {
      total: leadsResult.count ?? 0,
      qualified: qualifiedLeadsResult.count ?? 0,
      assigned: assignedLeadsResult.count ?? 0,
      converted: convertedLeadsResult.count ?? 0,
      topSources,
    },
    // AI-ISA
    isaPerformance: {
      outreachSent: outreachResult.count ?? 0,
      qualified: qualificationsResult.count ?? 0,
      appointmentsSet: appointmentsResult.count ?? 0,
      channelBreakdown: channelMap,
    },
    // Listings
    listingHealth: {
      active: activeListingsResult.count ?? 0,
      withOffers: listingsWithOffersResult.count ?? 0,
      closedPeriod: closedListingsResult.count ?? 0,
      topActive: (activeListingsResult.data ?? []).slice(0, 5),
    },
    // Transactions
    transactionHealth: {
      open: transactionsResult.data?.length ?? 0,
      atRisk: atRiskTransactions,
    },
    // Marketing
    marketingPerformance: marketingTotals,
    // Cross-domain stuck work
    stuckWork: {
      transactions: stuckTxResult.data ?? [],
      staleLeads: staleLeadsResult.data ?? [],
      acceptedOffersNoTx: acceptedOffersNoTxResult.data ?? [],
    },
  })
}
