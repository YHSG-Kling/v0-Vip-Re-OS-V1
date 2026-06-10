import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Resolve agent record for this user
  const { data: agent } = await supabase
    .from("agents")
    .select("id, brokerage_id, user_id")
    .eq("user_id", user.id)
    .maybeSingle()

  const agentId = agent?.id ?? null
  const brokerageId = agent?.brokerage_id ?? null

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
  const minus48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const minus5d = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
  const minus14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

  const [
    showingsResult,
    handoffsResult,
    draftsResult,
    transactionsResult,
    listingsResult,
    staleLeadsResult,
    // Broker-level counts
    activeAgentsResult,
    openTransactionsResult,
    newLeadsResult,
  ] = await Promise.all([
    // Today's showings for the agent
    agentId
      ? supabase
          .from("showings")
          .select("id, listing_id, contact_id, scheduled_at, status, notes, listing:listings(address, list_price)")
          .eq("agent_id", agentId)
          .gte("scheduled_at", todayStart)
          .lt("scheduled_at", todayEnd)
          .order("scheduled_at", { ascending: true })
      : Promise.resolve({ data: [] }),

    // Pending AI handoffs
    agentId
      ? supabase
          .from("agent_handoffs")
          .select("id, handoff_reason, entity_type, entity_id, created_at, from_agent_type, handoff_status")
          .eq("human_agent_id", agentId)
          .eq("handoff_status", "pending")
          .order("created_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: [] }),

    // AI message drafts awaiting review
    agentId
      ? supabase
          .from("ai_message_drafts")
          .select("id, draft_subject, draft_body, channel, created_at, contact_id, status")
          .eq("agent_user_id", agentId)
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: [] }),

    // Active transactions — check for stuck ones (no update >5d)
    brokerageId
      ? supabase
          .from("transactions")
          .select("id, deal_name, property_address, status, stage, updated_at, agent_id, contact_id")
          .eq("brokerage_id", brokerageId)
          .not("status", "in", "(closed,cancelled)")
          .lte("updated_at", minus5d)
          .order("updated_at", { ascending: true })
          .limit(20)
      : Promise.resolve({ data: [] }),

    // Listings in prep stage >14d
    brokerageId
      ? supabase
          .from("listings")
          .select("id, address, status, current_stage:lifecycle_stage, stage_entered_at, agent_id")
          .eq("brokerage_id", brokerageId)
          // Canonical lifecycle_stage vocabulary is the UPPERCASE state machine
          // (listings check constraint) — the old lowercase values matched NOTHING,
          // so "stuck in prep" never surfaced a single listing.
          .in("lifecycle_stage", [
            "COMING_SOON_PREP", "REPAIRS_IN_PROGRESS", "MEDIA_CAPTURE",
            "MEDIA_APPROVED", "MLS_READY", "COMING_SOON_ACTIVE",
          ])
          .lte("stage_entered_at", minus14d)
          .order("stage_entered_at", { ascending: true })
          .limit(20)
      : Promise.resolve({ data: [] }),

    // Leads qualified >48h unassigned
    brokerageId
      ? supabase
          .from("leads")
          .select("id, first_name, last_name, lead_stage, created_at, source, lead_score")
          .eq("brokerage_id", brokerageId)
          .eq("lead_stage", "qualified")
          .is("agent_id", null)
          .lte("updated_at", minus48h)
          .order("lead_score", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] }),

    // Broker snapshot — active agents
    brokerageId
      ? supabase
          .from("agents")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .eq("is_active", true)
      : Promise.resolve({ count: 0 }),

    // Open transactions count
    brokerageId
      ? supabase
          .from("transactions")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .not("status", "in", "(closed,cancelled)")
      : Promise.resolve({ count: 0 }),

    // New leads today
    brokerageId
      ? supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .gte("created_at", todayStart)
      : Promise.resolve({ count: 0 }),
  ])

  // Accepted offers with no transaction
  let acceptedOffersNoTx: any[] = []
  if (brokerageId) {
    const { data } = await supabase
      .from("offers")
      .select("id, listing_id, contact_id, offer_price, status, updated_at, listing:listings(address)")
      .eq("brokerage_id", brokerageId)
      .eq("status", "accepted")
      .is("transaction_id", null)
      .order("updated_at", { ascending: true })
      .limit(20)
    acceptedOffersNoTx = data ?? []
  }

  return NextResponse.json({
    agentId,
    brokerageId,
    // Agent view
    todayShowings: showingsResult.data ?? [],
    pendingHandoffs: handoffsResult.data ?? [],
    pendingDrafts: draftsResult.data ?? [],
    // Broker / stuck-work
    stuckTransactions: transactionsResult.data ?? [],
    stuckListings: listingsResult.data ?? [],
    staleQualifiedLeads: staleLeadsResult.data ?? [],
    acceptedOffersNoTx,
    // Broker snapshot counts
    activeAgentCount: activeAgentsResult.count ?? 0,
    openTransactionCount: openTransactionsResult.count ?? 0,
    newLeadsToday: newLeadsResult.count ?? 0,
  })
}
