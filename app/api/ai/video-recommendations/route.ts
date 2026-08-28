import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"
import { qualifiesForMemoryVideo, assessMemoryVideoTenure } from "@/lib/video/memory-video-gate"
import { parseLengthOfResidence } from "@/lib/avm/provider-chain"
import { CHECK_VOCABULARIES } from "@/scripts/check-vocabularies"

/**
 * GET /api/ai/video-recommendations?agent_id=… — "what should I film next".
 *
 * WIRED 2026-08-28 (orphan doctrine §1.2 — no duplicate existed and the
 * capability is wanted). Five recommendation branches lived here, each one
 * repaired by an earlier wave (phantom columns, a phantom embed, and the m565
 * memory-video tenure gate), and NOTHING in the tree had ever called the route:
 * every fix landed on a surface no agent could reach. The door is
 * app/dashboard/videos/board/video-recommendations-card.tsx, mounted on the
 * video pipeline board.
 *
 * TWO THINGS HAD TO BE TRUE BEFORE A DOOR COULD BE OPENED, and neither was:
 *
 * 1. THE VOCABULARY. `video_type` was emitted as "personalized_buyer", which is
 *    NOT a value ai_video_projects.video_type admits — it is a SCRIPT PURPOSE,
 *    from the unrelated map at app/actions/video-generation.ts:1301 and the
 *    picker at app/video-assistant/page.tsx:292. Two vocabularies wearing one
 *    field name is CLAUDE.md §6, and it is not cosmetic here: a surface that
 *    forwarded the token into a create call would be refused by the CHECK (the
 *    row is rejected ENTIRELY — §3), so the recommendation could never become a
 *    video. Every branch now emits a value from the LIVE CHECK, asserted below
 *    against the generated cache rather than against a list retyped here.
 *
 * 2. THE RAIL. "Make this video" is not one destination. memory_video may never
 *    be model-authored (owner ruling, m565), so sending it to the AI wizard —
 *    which exists to have a model write the script — is precisely the mistake
 *    the wizard's own tombstone records refusing. Each recommendation therefore
 *    names the rail the agent should act on, and the card routes by it.
 */
const VIDEO_TYPE_VOCABULARY: readonly string[] = CHECK_VOCABULARIES.ai_video_projects.video_type

/** Where the agent acts on a recommendation. The card routes on this. */
type RecommendationRail = "video_wizard" | "contact_detail"

/**
 * Fails CLOSED on a token the column would refuse. A recommendation that cannot
 * become a row is worse than a missing one: it is an offer the platform cannot
 * honour, and the agent finds that out at the insert.
 */
function assertVideoType(videoType: string): string {
  if (!VIDEO_TYPE_VOCABULARY.includes(videoType)) {
    throw new Error(
      `video-recommendations: "${videoType}" is not in ai_video_projects.video_type — ` +
      `regenerate scripts/check-vocabularies.ts or fix the branch`,
    )
  }
  return videoType
}

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
        // Was "personalized_buyer" — a SCRIPT PURPOSE, not a video type (see the
        // header). This branch's own suggested_content names what the clip is:
        // "properties matching their search + market update", and market_update
        // is the live value for it.
        video_type: assertVideoType("market_update"),
        rail: "video_wizard" as RecommendationRail,
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
        video_type: assertVideoType("listing_tour"),
        rail: "video_wizard" as RecommendationRail,
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
        // Was "personalized_buyer". m565 coined `home_anniversary` for EXACTLY
        // this moment and spelled it the way agent_intro_videos.trigger and
        // contacts.home_anniversary already spell it (§6); this branch is that
        // moment, one year after the close.
        //
        // THE RAIL IS NOT THE WIZARD, and that is the same ruling twice over.
        // lib/kernel/anniversary-equity.ts already commissions this clip and the
        // intro-video-email-backfill cron delivers it, so the agent's action is
        // to look at the client — not to film a second one. The wizard does not
        // even offer this type (app/dashboard/videos/create/video-create-client
        // .tsx:68's VIDEO_TYPES list), so sending them there would be a door
        // onto a menu with no matching entry.
        //
        // OWNER QUESTION, RAISED NOT ANSWERED: with the automatic rail already
        // in place, is this branch a recommendation at all, or a NOTIFICATION
        // that a clip is on its way? Left standing and labelled rather than
        // dropped — deleting it would be deleting a capability to tidy a number.
        video_type: assertVideoType("home_anniversary"),
        rail: "contact_detail" as RecommendationRail,
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
          video_type: assertVideoType("market_update"),
          rail: "video_wizard" as RecommendationRail,
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
    //
    // m565 ADDED THE RULE THE PERSONA COULD NOT STATE: the owner's ruling makes
    // eligibility a TENURE test ("more than 20 years"), so the persona is now the
    // situation signal and assessMemoryVideoTenure is the gate. Both run below.
    const { data: openSellerDeals, error: openSellerError } = await supabase
      .from("transactions")
      .select(
        "id, contact_id, seller_contact_id, client_name, property_address, seller:seller_contact_id(id, first_name, last_name, contact_persona, length_of_residence), client:contact_id(id, first_name, last_name, contact_persona, length_of_residence)",
      )
      .eq("agent_id", agentId)
      .eq("deal_type", "seller")
      .in("status", [...TRANSACTION_STATUSES_OPEN])
      .limit(5)

    if (openSellerError) {
      console.error("[v0] Video recommendations — open seller-deal read refused:", openSellerError)
      return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 })
    }

    type SellerContact = { id: string; first_name: string | null; last_name: string | null; contact_persona: string | null; length_of_residence: string | null }
    for (const txn of openSellerDeals || []) {
      const seller = ((txn as any).seller ?? (txn as any).client) as SellerContact | null
      if (!seller || !qualifiesForMemoryVideo(seller.contact_persona)) continue

      // THE OWNER'S RULE IS TENURE, AND IT FAILS CLOSED (m565).
      //
      // Two questions, two predicates, and neither substitutes for the other
      // (CLAUDE.md §6). The persona above says this is the SITUATION a memory
      // video is for — it is the client's own declaration, and it is why the age
      // operand this branch once carried is deliberately gone. The verdict below
      // is the ELIGIBILITY: "memory video is for sellers that have been in their
      // home more than 20 years". A persona alone can no longer produce the
      // recommendation, and a seller whose tenure the platform cannot establish
      // produces nothing at all rather than an offer it has not earned.
      //
      // Tenure is read through the ONE parser of contacts.length_of_residence in
      // this repo (lib/avm/provider-chain.ts::parseLengthOfResidence, the same
      // survivor lib/predictive-listing/signal-generators.ts derives tenure with).
      // There is no prior-purchase fallback here on purpose: the transaction in
      // hand is the CURRENT sale, not the purchase that started the clock.
      const tenure = assessMemoryVideoTenure(parseLengthOfResidence(seller.length_of_residence))
      if (!tenure.eligible) continue

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
          video_type: assertVideoType("memory_video"),
          // NEVER the wizard. The wizard's job is to have a MODEL write the
          // script, and the owner's ruling makes that the one thing a memory
          // video may never be — the option was removed from its menu with a
          // tombstone (app/dashboard/videos/create/video-create-client.tsx:82)
          // for exactly this reason. The rail is the seller's contact detail
          // view, where lib/video/memory-video.ts's offer and the seller-
          // dictated capture sheet live.
          rail: "contact_detail" as RecommendationRail,
          target_client_id: seller.id,
          client_name: [seller.first_name, seller.last_name].filter(Boolean).join(" ") || txn.client_name,
          property_address: txn.property_address,
          reason: `${tenure.reason} Seller-dictated keepsake — offer it, then capture their own words.`,
          suggested_content: "The seller dictates the history of the house; the platform writes none of it",
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
