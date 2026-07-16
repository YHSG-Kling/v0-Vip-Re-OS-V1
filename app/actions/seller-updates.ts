"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { KernelEvent } from "@/lib/kernel/events"
import { generateTextRouted as generateText } from "@/lib/ai/models"

interface GenerateDraftParams {
  listingId: string
  agentId: string
}

interface SendUpdateParams {
  listingId: string
  agentId: string
  messageBody: string
  approvedByAgentId: string
}

/**
 * Generate AI draft for weekly seller update
 * DRAFT-FIRST: Returns draft text only, never auto-sends
 */
export async function generateSellerUpdateDraft({ listingId, agentId }: GenerateDraftParams) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  // Fetch listing data
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select(`
      id,
      address,
      city,
      state,
      zip,
      list_price,
      status,
      contact_id,
      contacts!listings_contact_id_fkey (
        id,
        first_name,
        last_name
      )
    `)
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (listingError || !listing) {
    throw new Error("Listing not found")
  }

  // Calculate DOM (days on market)
  const { data: listingMetrics } = await supabase
    .from("listing_metrics")
    .select("date")
    .eq("listing_id", listingId)
    .order("date", { ascending: true })
    .limit(1)

  const firstMetricDate = listingMetrics?.[0]?.date
  const dom = firstMetricDate
    ? Math.floor((Date.now() - new Date(firstMetricDate).getTime()) / (1000 * 60 * 60 * 24))
    : 0

  // Fetch last 7 days of showings
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  const { data: showings } = await supabase
    .from("showings")
    .select("id, scheduled_at, status, feedback, rating")
    .eq("listing_id", listingId)
    .gte("scheduled_at", sevenDaysAgo.toISOString())
    .order("scheduled_at", { ascending: false })

  // Fetch showing feedback for this listing
  const { data: feedbackData } = await supabase
    .from("showing_feedback")
    .select(`
      id,
      overall_impression,
      specific_concerns,
      price_opinion,
      sentiment_score,
      created_at,
      showing_id
    `)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(10)

  // Filter feedback to only include those for this listing's showings
  const showingIds = showings?.map(s => s.id) || []
  const relevantFeedback = feedbackData?.filter(f => showingIds.includes(f.showing_id)) || []

  // Fetch transaction milestones if there's an active transaction
  const { data: transaction } = await supabase
    .from("transactions")
    .select("id, status, stage")
    .eq("listing_id", listingId)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single()

  let milestones: any[] = []
  if (transaction) {
    const { data: milestonesData } = await supabase
      .from("transaction_milestones")
      .select("milestone_name, status, target_date, completed_at")
      .eq("transaction_id", transaction.id)
      .order("target_date", { ascending: true })

    milestones = milestonesData || []
  }

  // Build context for AI
  const sellerName = listing.contacts
    ? `${(listing.contacts as any[])[0]?.first_name ?? ""} ${(listing.contacts as any[])[0]?.last_name ?? ""}`.trim() || "Seller"
    : "Seller"

  const showingCount = showings?.length || 0
  const avgRating = relevantFeedback.length > 0
    ? relevantFeedback.reduce((sum, f) => sum + (f.sentiment_score || 3), 0) / relevantFeedback.length
    : null

  const feedbackSummary = relevantFeedback.map(f => ({
    impression: f.overall_impression,
    concerns: f.specific_concerns,
    priceOpinion: f.price_opinion,
  }))

  const contextPrompt = `
Listing: ${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}
List Price: $${listing.list_price?.toLocaleString() || "N/A"}
Days on Market: ${dom}
Status: ${listing.status}
Seller Name: ${sellerName}

This Week's Activity:
- Showings: ${showingCount}
- Average Feedback Rating: ${avgRating ? avgRating.toFixed(1) + "/5" : "No feedback yet"}

Recent Feedback Summary:
${feedbackSummary.length > 0
  ? feedbackSummary.map((f, i) => `${i + 1}. Impression: ${f.impression || "N/A"}, Concerns: ${f.concerns || "None noted"}, Price Opinion: ${f.priceOpinion || "N/A"}`).join("\n")
  : "No feedback received this week"}

${milestones.length > 0 ? `
Transaction Milestones:
${milestones.map(m => `- ${m.milestone_name}: ${m.status} (${m.target_date})`).join("\n")}
` : ""}
`

  // Call AI to generate draft
  const { text: draftText } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt: `You are a real estate agent writing a weekly update to your seller client.
Be warm, professional, and specific. Max 200 words.
Focus on:
1. Activity summary (showings, interest level)
2. Feedback highlights (without being negative)
3. Market positioning
4. Next steps or recommendations
Do NOT include subject lines or greetings like "Dear" - start directly with the update content.

Generate a weekly seller update email based on this context:

${contextPrompt}`,
  })

  return {
    draft: draftText,
    context: {
      listingAddress: listing.address,
      sellerName,
      showingCount,
      dom,
      avgRating,
    },
  }
}

/**
 * Send approved seller update
 * Only fires after explicit agent approval
 */
export async function sendSellerUpdate({ listingId, agentId, messageBody, approvedByAgentId }: SendUpdateParams) {
  const supabase = await createClient()
  const { agentId: authAgentId, brokerageId } = await getAgentContext()

  // Validate approvedByAgentId matches authenticated agent
  if (approvedByAgentId !== authAgentId) {
    throw new Error("Agent approval mismatch")
  }

  // Fetch listing to get contact_id
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, contact_id, address")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (listingError || !listing || !listing.contact_id) {
    throw new Error("Listing or seller contact not found")
  }

  // Insert message into client_portal_messages
  const { data: message, error: messageError } = await supabase
    .from("client_portal_messages")
    .insert({
      contact_id: listing.contact_id,
      agent_id: agentId,
      brokerage_id: brokerageId,
      body: messageBody,
      direction: "agent_to_client",
      read_at: null,
    })
    .select()
    .single()

  if (messageError) {
    throw new Error(`Failed to send message: ${messageError.message}`)
  }

  // Emit kernel event
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type: "listing",
    entity_id: listingId,
    event_type: KernelEvent.SELLER_UPDATE_SENT,
    actor_user_id: approvedByAgentId,
    metadata: {
      message_id: message.id,
      contact_id: listing.contact_id,
      listing_address: listing.address,
    },
  })

  return { success: true, messageId: message.id }
}

/**
 * Get showing feedback for a listing
 */
export async function getShowingFeedback(listingId: string) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  // First get all showings for this listing
  const { data: showings } = await supabase
    .from("showings")
    .select("id")
    .eq("listing_id", listingId)
    .eq("brokerage_id", brokerageId)

  if (!showings || showings.length === 0) {
    return []
  }

  const showingIds = showings.map(s => s.id)

  // Then get feedback for those showings
  const { data: feedback, error } = await supabase
    .from("showing_feedback")
    .select(`
      id,
      overall_impression,
      specific_concerns,
      buyer_favorite_features,
      price_opinion,
      sentiment_score,
      created_at,
      showing_id
    `)
    .in("showing_id", showingIds)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(10)

  if (error) {
    throw new Error(`Failed to fetch feedback: ${error.message}`)
  }

  // Categorize by sentiment
  const categorized = {
    positive: feedback?.filter(f => (f.sentiment_score || 3) >= 4) || [],
    neutral: feedback?.filter(f => (f.sentiment_score || 3) === 3) || [],
    negative: feedback?.filter(f => (f.sentiment_score || 3) < 3) || [],
  }

  return {
    all: feedback || [],
    categorized,
    counts: {
      positive: categorized.positive.length,
      neutral: categorized.neutral.length,
      negative: categorized.negative.length,
    },
  }
}

/**
 * Get communication history for seller
 */
export async function getSellerCommunicationHistory(listingId: string) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  // Get listing's contact_id
  const { data: listing } = await supabase
    .from("listings")
    .select("contact_id")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (!listing?.contact_id) {
    return []
  }

  const { data: messages, error } = await supabase
    .from("client_portal_messages")
    .select("id, body, direction, read_at, created_at")
    .eq("contact_id", listing.contact_id)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(5)

  if (error) {
    throw new Error(`Failed to fetch messages: ${error.message}`)
  }

  return messages || []
}

/**
 * Get price recommendation analysis
 * Advisory only - no automatic price changes
 */
export async function getPriceRecommendation(listingId: string) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  // Fetch listing data
  const { data: listing } = await supabase
    .from("listings")
    .select("id, list_price, status")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (!listing) {
    return null
  }

  // Calculate DOM
  const { data: listingMetrics } = await supabase
    .from("listing_metrics")
    .select("date")
    .eq("listing_id", listingId)
    .order("date", { ascending: true })
    .limit(1)

  const firstMetricDate = listingMetrics?.[0]?.date
  const dom = firstMetricDate
    ? Math.floor((Date.now() - new Date(firstMetricDate).getTime()) / (1000 * 60 * 60 * 24))
    : 0

  // Get feedback for avg rating
  const { data: showings } = await supabase
    .from("showings")
    .select("id")
    .eq("listing_id", listingId)

  const showingIds = showings?.map(s => s.id) || []

  const { data: feedback } = await supabase
    .from("showing_feedback")
    .select("sentiment_score")
    .in("showing_id", showingIds)

  const avgRating = feedback && feedback.length > 0
    ? feedback.reduce((sum, f) => sum + (f.sentiment_score || 3), 0) / feedback.length
    : null

  // Get recent showings count per week
  const fourWeeksAgo = new Date()
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28)

  const { data: recentShowings } = await supabase
    .from("showings")
    .select("id, scheduled_at")
    .eq("listing_id", listingId)
    .gte("scheduled_at", fourWeeksAgo.toISOString())

  const showingsPerWeek = recentShowings ? recentShowings.length / 4 : 0

  // Determine if recommendation should be shown
  // Criteria: DOM > 21 AND avg feedback rating < 3.5
  const shouldShowRecommendation = dom > 21 && avgRating !== null && avgRating < 3.5

  if (!shouldShowRecommendation) {
    return null
  }

  return {
    showRecommendation: true,
    currentPrice: listing.list_price,
    dom,
    avgFeedbackRating: avgRating,
    showingsPerWeek: Math.round(showingsPerWeek * 10) / 10,
    reasoning: `This listing has been on the market for ${dom} days with an average feedback rating of ${avgRating?.toFixed(1)}/5. With ${showingsPerWeek.toFixed(1)} showings per week, a price adjustment may help attract more qualified buyers.`,
    label: "AI Insight — for agent review only",
  }
}
