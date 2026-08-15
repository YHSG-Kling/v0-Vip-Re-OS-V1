import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

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
    const { data: callerAgent } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle()
    if (!callerAgent?.id || callerAgent.id !== agentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const recommendations: any[] = []
    const now = new Date()

    // 1. High activity leads with no recent contact (7+ days)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const { data: highActivityLeads } = await supabase
      .from("leads")
      .select("*")
      .eq("agent_id", agentId)
      .gte("engagement_score", 50)
      .or(`last_contact_at.lt.${sevenDaysAgo.toISOString()},last_contact_at.is.null`)
      .limit(5)

    for (const lead of highActivityLeads || []) {
      const daysSinceContact = lead.last_contact_at
        ? Math.floor((now.getTime() - new Date(lead.last_contact_at).getTime()) / (1000 * 60 * 60 * 24))
        : 30

      recommendations.push({
        type: "high_priority",
        video_type: "personalized_buyer",
        target_client_id: lead.id,
        client_name: lead.first_name || lead.name,
        reason: `Viewed ${lead.properties_viewed || "multiple"} properties but no response in ${daysSinceContact} days`,
        suggested_content: "Properties matching their search + market update",
        priority_score: 90 - Math.min(daysSinceContact, 30),
        engagement_score: lead.engagement_score,
      })
    }

    // 2. New listings without videos
    const { data: listingsWithoutVideos } = await supabase
      .from("transactions")
      .select("*")
      .eq("agent_id", agentId)
      .eq("status", "active")
      .or("listing_video_id.is.null")
      .limit(5)

    for (const listing of listingsWithoutVideos || []) {
      recommendations.push({
        type: "listing_opportunity",
        video_type: "listing_tour",
        target_property_id: listing.property_id || listing.id,
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

    const { data: anniversaryClients } = await supabase
      .from("transactions")
      .select("*, leads(*)")
      .eq("agent_id", agentId)
      .eq("status", "closed")
      .gte("close_date", anniversaryStart.toISOString().split("T")[0])
      .lte("close_date", anniversaryEnd.toISOString().split("T")[0])
      .limit(5)

    for (const txn of anniversaryClients || []) {
      const closeDate = new Date(txn.close_date)
      const daysUntilAnniversary = Math.ceil((closeDate.getTime() + 365 * 24 * 60 * 60 * 1000 - now.getTime()) / (1000 * 60 * 60 * 24))

      recommendations.push({
        type: "upcoming_opportunity",
        video_type: "personalized_buyer",
        target_client_id: txn.lead_id || txn.leads?.id,
        client_name: txn.leads?.first_name || txn.client_name,
        property_address: txn.property_address,
        reason: `1-year anniversary of home purchase in ${daysUntilAnniversary} days`,
        suggested_content: "Anniversary congratulations + check-in",
        priority_score: 70,
      })
    }

    // 4. Market update opportunity - check if one was sent recently
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const { data: recentMarketVideo, error: marketVideoError } = await supabase
      .from("ai_video_projects")
      .select("id")
      .eq("agent_id", agentId)
      .eq("video_type", "market_update")
      .gte("created_at", thirtyDaysAgo.toISOString())
      .limit(1)

    if (!recentMarketVideo || recentMarketVideo.length === 0) {
      // Count active buyer leads
      const { count: buyerCount } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", agentId)
        .eq("lead_type", "buyer")
        .eq("status", "active")

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

    // 5. Sellers who might benefit from memory videos
    const { data: seniorSellers } = await supabase
      .from("transactions")
      .select("*, leads(*)")
      .eq("agent_id", agentId)
      .eq("transaction_type", "listing")
      .in("status", ["active", "pending"])
      .limit(5)

    for (const txn of seniorSellers || []) {
      if (txn.leads?.persona_type === "downsizer" || txn.leads?.age_range === "55+") {
        // Check if memory video already exists
        const { data: existingMemoryVideo } = await supabase
          .from("ai_video_projects")
          .select("id")
          .eq("lead_id", txn.lead_id)
          .eq("video_type", "memory_video")
          .limit(1)

        if (!existingMemoryVideo || existingMemoryVideo.length === 0) {
          recommendations.push({
            type: "upcoming_opportunity",
            video_type: "memory_video",
            target_client_id: txn.lead_id,
            client_name: txn.leads?.first_name || txn.client_name,
            property_address: txn.property_address,
            reason: "Long-time homeowner selling - opportunity for heartfelt memory video",
            suggested_content: "Celebrate their memories + new chapter",
            priority_score: 65,
          })
        }
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
