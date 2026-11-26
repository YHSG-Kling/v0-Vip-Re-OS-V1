import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { loadRoiOutcomeLedger } from "@/lib/intelligence/roi-ledger"

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
          // Canonical UPPERCASE stage vocabulary (see listings check constraint) —
          // the old lowercase values matched NOTHING, so "listings with active
          // offers" always reported 0.
          .in("lifecycle_stage", ["OFFERS_RECEIVED", "NEGOTIATION", "UNDER_CONTRACT"])
      : Promise.resolve({ count: 0 }),

    // Closed listings in period
    brokerageId
      ? supabase
          .from("listings")
          .select("id, list_price, address", { count: "exact" })
          .eq("brokerage_id", brokerageId)
          // listings.status has no "closed" — the terminal status is "sold", so this
          // "Closed listings in period" figure was permanently 0.
          .eq("status", "sold")
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

    // Marketing spend and outcomes — wave 152 (lane 152B): THE authorized ROI reader, with the SESSION's own ids.
    // This used to sum campaign_roi brokerage-wide for ANY signed-in agent: an unknown spend added as $0, the
    // invented conversions × $7,500 revenue, and commission dollars on an agent's screen (CLAUDE.md §5).
    brokerageId
      ? loadRoiOutcomeLedger(createServiceClient(), { userId: user.id, brokerageId }, { sinceDay: startIso.slice(0, 10), untilDay: now.toISOString().slice(0, 10) })
      : Promise.resolve(null),

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

  // Marketing outcomes from the authorized reader. Families stay apart: leads = contacts the campaigns reached,
  // conversions = closed deals a campaign sourced, revenue = their earned commission (null when commission is off
  // this viewer's display or not established), spend = recorded spend (null when nothing records it).
  const ledger = campaignResult && campaignResult.ok ? campaignResult.ledger : null
  const marketingTotals = {
    totalSpend: ledger && ledger.costs.status !== "unknown" ? ledger.costs.knownCents / 100 : null,
    totalLeads: ledger?.acquisition.contactsReached ?? 0,
    totalConversions: ledger?.results.sourcedDealsClosed ?? 0,
    totalRevenue: ledger?.attribution ? ledger.attribution.sourcedEarnedCents / 100 : null,
    spendStatus: ledger?.costs.status ?? "unknown",
    realizedReturn: ledger?.ratios.realizedReturnOnMarketingSpend.value ?? null,
    note: !campaignResult ? null : !campaignResult.ok ? campaignResult.error : (ledger?.scope.moneyNote ?? ledger?.ratios.realizedReturnOnMarketingSpend.na ?? null),
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
