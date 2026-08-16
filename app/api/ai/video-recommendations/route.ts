import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"
import { qualifiesForMemoryVideo } from "@/lib/video/memory-video-gate"

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Auth gate — anyone could previously probe this endpoint, enumerating
    // agent_ids and forcing real DB queries (which RLS would mostly block but
    // burns server time + leaks existence info via timing/errors).
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const agentId = searchParams.get("agent_id")

    if (!agentId) {
      return NextResponse.json({ error: "agent_id is required" }, { status: 400 })
    }

    // The caller may only request recommendations for an agent they ARE.
    const { data: callerAgent, error: callerAgentError } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle()
    // A refused identity read is not "you are not this agent" — say so rather
    // than answering 403 for what is actually a broken read.
    if (callerAgentError) {
      console.error("[v0] Video recommendations — caller identity read refused:", callerAgentError)
      return NextResponse.json({ error: "Failed to verify caller" }, { status: 500 })
    }
    if (!callerAgent?.id || callerAgent.id !== agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const recommendations: any[] = []
    const now = new Date()

    // 1. High activity leads with no recent contact (7+ days)
    // leads has lead_score + last_contacted_at (engagement_score / last_contact_at
    // don't exist — the old filters errored the query, so this recommendation type
    // NEVER fired and high-intent quiet leads got no video nudge).
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const { data: highActivityLeads, error: highActivityError } = await supabase
      .from("leads")
      .select("id, first_name, last_name, lead_score, last_contacted_at")
      .eq("agent_id", agentId)
      .gte("lead_score", 50)
      .or(`last_contacted_at.lt.${sevenDaysAgo.toISOString()},last_contacted_at.is.null`)
      .limit(5)

    // supabase-js RESOLVES a refused read. Without this the endpoint would report
    // "no quiet high-intent leads" for a permission error.
    if (highActivityError) {
      console.error("[v0] Video recommendations — quiet-lead read refused:", highActivityError)
      return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 })
    }

    for (const lead of highActivityLeads || []) {
      const daysSinceContact = lead.last_contacted_at
        ? Math.floor((now.getTime() - new Date(lead.last_contacted_at).getTime()) / (1000 * 60 * 60 * 24))
        : 30

      recommendations.push({
        type: "high_priority",
        video_type: "personalized_buyer",
        target_client_id: lead.id,
        client_name: [lead.first_name, lead.last_name].filter(Boolean).join(" ") || null,
        reason: `High-intent lead (score ${lead.lead_score}) but no response in ${daysSinceContact} days`,
        suggested_content: "Properties matching their search + market update",
        priority_score: 90 - Math.min(daysSinceContact, 30),
        engagement_score: lead.lead_score,
      })
    }

    // 2. New listings without videos
    // `transactions.listing_video_id` does not exist — nothing in the schema carries a
    // per-listing video id column. The link runs the OTHER way: a video row points at its
    // listing via ai_video_projects.listing_id. So "has no video yet" is a NOT EXISTS against
    // that table and can never be expressed as a column filter on transactions. The phantom
    // .or() made PostgREST reject the whole request (exactly like the leads filters above,
    // fixed earlier), so this recommendation type has never produced a single row.
    const { data: agentVideoProjects, error: videoProjectsError } = await supabase
      .from("ai_video_projects")
      .select("listing_id")
      .eq("agent_id", agentId)
      .not("listing_id", "is", null)
    if (videoProjectsError) {
      console.error("[v0] Video recommendations — video-project read refused:", videoProjectsError)
      return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 })
    }
    const listingIdsWithVideo = new Set((agentVideoProjects || []).map((p) => p.listing_id))

    // Columns named: `property_id` is not a column on this table, so the old
    // starred select let the id fall through to the transaction id unnoticed.
    const { data: activeListingTxns, error: activeListingError } = await supabase
      .from("transactions")
      .select("id, listing_id, property_address")
      .eq("agent_id", agentId)
      .eq("status", "active")
      // Fetch wider than the 5 surfaced: the "already has a video" exclusion happens below,
      // so a page-sized limit here could otherwise be consumed entirely by filtered-out rows.
      .limit(50)
    if (activeListingError) {
      console.error("[v0] Video recommendations — active-listing read refused:", activeListingError)
      return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 })
    }
    const listingsWithoutVideos = (activeListingTxns || [])
      .filter((t) => !t.listing_id || !listingIdsWithVideo.has(t.listing_id))
      .slice(0, 5)

    for (const listing of listingsWithoutVideos) {
      recommendations.push({
        type: "listing_opportunity",
        video_type: "listing_tour",
        target_listing_id: listing.listing_id,
        target_transaction_id: listing.id,
        property_address: listing.property_address,
        reason: "New listing activated, no video yet",
        suggested_content: "Listing tour highlighting key features",
        priority_score: 85,
      })
    }

    // 3. Upcoming anniversaries (1-year home purchase)
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)
    const anniversaryStart = new Date(oneYearAgo.getTime() - 7 * 24 * 60 * 60 * 1000)
    const anniversaryEnd = new Date(oneYearAgo.getTime() + 7 * 24 * 60 * 60 * 1000)

    // The client of a deal is a CONTACT: transactions.contact_id FKs contacts(id).
    // There is no foreign key joining transactions and leads in either direction,
    // so the deal cannot embed a lead at all — PostgREST rejects the whole request
    // and this recommendation type produced nothing. The embed names its FK column
    // because transactions reaches contacts through three different columns.
    const { data: anniversaryClients, error: anniversaryError } = await supabase
      .from("transactions")
      .select("id, contact_id, client_name, property_address, close_date, client:contact_id(id, first_name, last_name)")
      .eq("agent_id", agentId)
      .eq("status", "closed")
      .gte("close_date", anniversaryStart.toISOString().split("T")[0])
      .lte("close_date", anniversaryEnd.toISOString().split("T")[0])
      .limit(5)

    if (anniversaryError) {
      console.error("[v0] Video recommendations — anniversary read refused:", anniversaryError)
      return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 })
    }

    for (const txn of anniversaryClients || []) {
      const closeDate = new Date(txn.close_date)
      const daysUntilAnniversary = Math.ceil((closeDate.getTime() + 365 * 24 * 60 * 60 * 1000 - now.getTime()) / (1000 * 60 * 60 * 24))
      const client = (txn as any).client as { id: string; first_name: string | null; last_name: string | null } | null

      recommendations.push({
        type: "upcoming_opportunity",
        video_type: "personalized_buyer",
        target_client_id: txn.contact_id ?? client?.id ?? null,
        client_name: [client?.first_name, client?.last_name].filter(Boolean).join(" ") || txn.client_name,
        property_address: txn.property_address,
        reason: `1-year anniversary of home purchase in ${daysUntilAnniversary} days`,
        suggested_content: "Anniversary congratulations + check-in",
        priority_score: 70,
      })
    }

    // 4. Market update opportunity - check if one was sent recently
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const { data: recentMarketVideo, error: recentMarketVideoError } = await supabase
      .from("ai_video_projects")
      .select("id")
      .eq("agent_id", agentId)
      .eq("video_type", "market_update")
      .gte("created_at", thirtyDaysAgo.toISOString())
      .limit(1)

    if (recentMarketVideoError) {
      console.error("[v0] Video recommendations — recent market-video read refused:", recentMarketVideoError)
      return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 })
    }

    if (!recentMarketVideo || recentMarketVideo.length === 0) {
      // Count active buyer leads
      const { count: buyerCount, error: buyerCountError } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", agentId)
        .eq("lead_type", "buyer")
        .eq("status", "active")

      if (buyerCountError) {
        console.error("[v0] Video recommendations — buyer-count read refused:", buyerCountError)
        return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 })
      }

      if (buyerCount && buyerCount > 5) {
        recommendations.push({
          type: "high_priority",
          video_type: "market_update",
          reason: `No market update in 30 days, ${buyerCount} active buyer clients`,
          suggested_content: "Market conditions + what it means for buyers",
          priority_score: 75,
          client_count: buyerCount,
        })
      }
    }

    // 5. Sellers whose situation calls for a memory video.
    //
    // The qualifying signal is contacts.contact_persona, reached through the
    // deal's seller contact (falling back to the generic client contact). It is
    // NOT a lead property: there is no foreign key between transactions and
    // leads, and the lead table has no age column — the old gate read two fields
    // that could not exist, so it never once evaluated true.
    //
    // The age half of the old gate is gone on purpose rather than repointed: a
    // contact age band is recorded, but selecting who gets marketing by age is
    // protected-class targeting. The persona states the same situation and the
    // client declares it themselves. See lib/video/memory-video-gate.ts.
    const { data: openSellerDeals, error: openSellerError } = await supabase
      .from("transactions")
      .select(
        "id, contact_id, seller_contact_id, client_name, property_address, seller:seller_contact_id(id, first_name, last_name, contact_persona), client:contact_id(id, first_name, last_name, contact_persona)",
      )
      .eq("agent_id", agentId)
      .eq("deal_type", "seller")
      .in("status", [...TRANSACTION_STATUSES_OPEN])
      .limit(5)

    if (openSellerError) {
      console.error("[v0] Video recommendations — open seller-deal read refused:", openSellerError)
      return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 })
    }

    type SellerContact = { id: string; first_name: string | null; last_name: string | null; contact_persona: string | null }
    for (const txn of openSellerDeals || []) {
      const seller = ((txn as any).seller ?? (txn as any).client) as SellerContact | null
      if (!seller || !qualifiesForMemoryVideo(seller.contact_persona)) continue

      // Already commissioned? ai_video_projects.contact_id is a real column —
      // the client link does not have to be dug out of the metadata jsonb.
      const { data: existingMemoryVideo, error: existingMemoryVideoError } = await supabase
        .from("ai_video_projects")
        .select("id")
        .eq("contact_id", seller.id)
        .eq("video_type", "memory_video")
        .limit(1)

      if (existingMemoryVideoError) {
        console.error("[v0] Video recommendations — memory-video read refused:", existingMemoryVideoError)
        return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 })
      }

      if (!existingMemoryVideo || existingMemoryVideo.length === 0) {
        recommendations.push({
          type: "upcoming_opportunity",
          video_type: "memory_video",
          target_client_id: seller.id,
          client_name: [seller.first_name, seller.last_name].filter(Boolean).join(" ") || txn.client_name,
          property_address: txn.property_address,
          reason: "Long-time homeowner selling - opportunity for heartfelt memory video",
          suggested_content: "Celebrate their memories + new chapter",
          priority_score: 65,
        })
      }
    }

    // Sort by priority score
    recommendations.sort((a, b) => b.priority_score - a.priority_score)

    // Note: there's no persisted video_recommendations table in the live
    // schema (verified via information_schema). Recommendations are computed
    // on demand and returned to the caller; the previous .upsert() to a
    // non-existent table was a silent no-op (removed).

    return NextResponse.json({
      success: true,
      recommendations: recommendations.slice(0, 10),
      total_found: recommendations.length,
    })
  } catch (error: any) {
    console.error("[v0] Video recommendations error:", error)
    return NextResponse.json({ error: "Failed to generate recommendations", details: error.message }, { status: 500 })
  }
}
