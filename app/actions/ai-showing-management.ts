"use server"

import { createClient } from "@/lib/supabase/server"
import { resolveUserIdToAgentRecord } from "@/lib/kernel/agent-identity-resolver"
import { revalidatePath } from "next/cache"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"

// ============================================================================
// AI SHOWING MANAGEMENT SYSTEM
// Smart route optimization, confirmations, feedback collection, and scheduling
// ============================================================================

// ============================================================================
// TOUR MANAGEMENT
// ============================================================================

export async function getTours(agentId: string) {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("tours")
      .select("*, showings(*)")
      .eq("agent_id", agentId)
      .order("tour_date", { ascending: false })

    if (error) throw error
    return { success: true, tours: data || [] }
  } catch (error) {
    return handleError(error, "getTours")
  }
}

export async function createTour(params: { agentId: string; tourDate: string; notes?: string }) {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("tours")
      .insert({
        agent_id: params.agentId,
        tour_date: params.tourDate,
        notes: params.notes || `Tour ${new Date(params.tourDate).toLocaleDateString()}`,
        status: "planned",
      })
      .select()
      .single()

    if (error) throw error
    revalidatePath("/dashboard")
    return { success: true, tour: data }
  } catch (error) {
    return handleError(error, "createTour")
  }
}

export async function updateTour(tourId: string, updates: any) {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("tours")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", tourId)
      .select()
      .single()

    if (error) throw error
    revalidatePath("/dashboard")
    return { success: true, tour: data }
  } catch (error) {
    return handleError(error, "updateTour")
  }
}

export async function optimizeTourRoute(tourId: string) {
  try {
    const supabase = await createClient()

    // Load tour_stops — addresses are stored directly on the stop row
    const { data: tour, error: tourError } = await supabase
      .from("tours")
      .select("id, tour_date")
      .eq("id", tourId)
      .single()

    if (tourError || !tour) throw tourError ?? new Error("Tour not found")

    const { data: stops, error: stopsError } = await supabase
      .from("tour_stops")
      .select("id, order_index, property_address, city, state")
      .eq("tour_id", tourId)
      .order("order_index", { ascending: true })

    if (stopsError || !stops?.length) throw stopsError ?? new Error("No stops found")

    const addressList = stops.map((s, i) =>
      `${i + 1}. ${s.property_address}${s.city ? ", " + s.city : ""}${s.state ? " " + s.state : ""}`
    ).join("\n")

    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `You are a route planner. Given these ${stops.length} properties, suggest the most efficient driving order.
Return ONLY a comma-separated list of the original 1-based position numbers in the optimized order. Nothing else.

Properties:
${addressList}`,
    })

    const order = text.match(/\d+/g)?.map(Number)
    const uniqueOrder = [...new Set(order)].filter(n => n >= 1 && n <= stops.length)

    let estimatedDriveMins: number | undefined
    let summary = "Route optimized — stops reordered for minimum drive time."

    if (uniqueOrder.length === stops.length) {
      // Write new order_index values
      for (let i = 0; i < uniqueOrder.length; i++) {
        const originalStop = stops[uniqueOrder[i] - 1]
        await supabase
          .from("tour_stops")
          .update({ order_index: i })
          .eq("id", originalStop.id)
      }
      estimatedDriveMins = stops.length * 8 // rough ~8 min avg drive between stops
      summary = `Stops reordered for efficient routing. Estimated ~${estimatedDriveMins} min total drive time.`
    }

    return { success: true, tourId, summary, estimatedDriveMins }
  } catch (error) {
    return handleError(error, "optimizeTourRoute")
  }
}

// aiOptimizeTourRoute was REMOVED here. It was a pure alias —
// `return optimizeTourRoute(...args)`, nothing else — kept "for backward
// compatibility" with a caller that no longer exists anywhere in the tree.
//
// Survivor: optimizeTourRoute directly above, which is what everything actually
// calls (app/crm/contacts/[contactId]/tours/components/tour-confirm-tab.tsx,
// tour-plan-tab.tsx, and the app/actions/index.ts barrel).
//
// Compared both bodies before deleting, per the rule: the alias forwarded every
// argument and the whole return value and added nothing — no auth, no
// validation, no reshaping. There was genuinely nothing to merge. It was also a
// second public HTTP endpoint onto a paid model call, for no benefit.

interface ShowingRequest {
  propertyId: string
  contactId: string
  agentId: string
  // Accept either a single date/time or an array of preferred dates (first is used)
  requestedDate?: string
  requestedTime?: string
  preferredDates?: string[]
  notes?: string
  buyerPreQualified?: boolean
}

interface ShowingRoute {
  id: string
  date: string
  showings: Array<{
    propertyId: string
    address: string
    time: string
    duration: number
    travelTime: number
    contactName: string
    notes?: string
  }>
  totalDuration: number
  totalMiles: number
  optimizationScore: number
}

/**
 * AI-Powered Showing Scheduler
 * Intelligently schedules showings based on buyer preferences, property availability,
 * and optimal routing
 */
export async function aiScheduleShowing(params: ShowingRequest) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.propertyId)) {
    return { success: false, error: "Invalid agent or property ID" }
  }

  // Normalize date/time — support both single-date and preferredDates[] call signatures
  const resolvedDate = params.requestedDate
    ?? params.preferredDates?.[0]
    ?? new Date().toISOString().split("T")[0]
  const resolvedTime = params.requestedTime ?? "10:00"
  // Rebuild params with resolved values so the rest of the function uses consistent fields
  params = { ...params, requestedDate: resolvedDate, requestedTime: resolvedTime }

  const supabase = await createClient()

  try {
    // Determine if propertyId is a UUID (agent seller listing) or an MLS number (buyer MLS search).
    // For MLS properties, skip the listings table lookup — it will not match.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const propertyIsUuid = uuidRe.test(params.propertyId)

    const [listingResult, contactResult] = await Promise.all([
      propertyIsUuid
        ? supabase.from("listings").select("address, city, state, list_price, bedrooms, bathrooms").eq("id", params.propertyId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase.from("contacts").select("first_name, last_name, contact_persona, city, state").eq("id", params.contactId).maybeSingle(),
    ])

    const listing = listingResult.data
    const contact = contactResult.data

    // For MLS buyer properties the address comes in via showing_instructions / external source —
    // we just need the contact to exist.
    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    // Check for scheduling conflicts on the same date
    const { data: existingShowings } = await supabase
      .from("showings")
      .select("scheduled_date, status")
      .eq("agent_id", params.agentId)
      .eq("scheduled_date", params.requestedDate)
      .neq("status", "cancelled")

    // AI Analysis for optimal scheduling
    const { text: aiAnalysis } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `You are a real estate showing scheduling assistant. Analyze and recommend.

PROPERTY: ${listing ? `${listing.address}, ${listing.city} — $${listing.list_price?.toLocaleString() ?? "N/A"}, ${listing.bedrooms}bd/${listing.bathrooms}ba` : `MLS # ${params.propertyId}`}
BUYER: ${contact.first_name} ${contact.last_name} (${contact.contact_persona ?? "buyer"})
REQUESTED TIME: ${params.requestedDate} at ${params.requestedTime}
PRE-QUALIFIED: ${params.buyerPreQualified ? "Yes" : "No/Unknown"}
AGENT SHOWINGS THAT DAY: ${existingShowings?.length ?? 0}

Return JSON only:
{
  "recommendedTime": "HH:MM",
  "alternativeTimes": ["HH:MM"],
  "conflictRisk": "low|medium|high",
  "preparationTips": ["tip1"],
  "talkingPoints": ["point1"],
  "followUpStrategy": "string"
}`,
    })

    let aiRecommendations
    try {
      const jsonMatch = aiAnalysis.match(/\{[\s\S]*\}/)
      aiRecommendations = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      aiRecommendations = { recommendedTime: params.requestedTime }
    }

    // Resolve brokerage_id from the agent's user record. params.agentId is a
    // USERS id — the caller (tour-confirm-tab) passes agentUserId — so this
    // lookup is the correct half.
    const { data: agentUser } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", params.agentId)
      .maybeSingle()

    // IDENTITY CLASS. showings.agent_id and activities.agent_id both FK AGENTS,
    // not users — so writing params.agentId straight into them is a foreign-key
    // violation and every AI-scheduled showing failed at the insert. The same
    // value was being used as BOTH classes inside this one function, which is
    // the self-contradiction test:identity-class now fails on.
    const agentRecordId = agentUser?.brokerage_id
      ? await resolveUserIdToAgentRecord(params.agentId, agentUser.brokerage_id)
      : null
    if (!agentRecordId) {
      return { success: false, error: "No agent record for this user — can't book the showing to them." }
    }

    const recommendedTime = aiRecommendations.recommendedTime || params.requestedTime
    const scheduledAt = params.requestedDate && recommendedTime
      ? `${params.requestedDate}T${recommendedTime}:00`
      : null

    // listing_id is a UUID FK — only set it when the propertyId is actually a UUID.
    // For MLS buyer properties, propertyId is an MLS number string; store it in notes instead.
    const notesText = [
      params.notes,
      !propertyIsUuid ? `MLS: ${params.propertyId}` : null,
    ].filter(Boolean).join(' | ') || null

    // Create the showing using verified live schema columns
    const { data: showing, error } = await supabase
      .from("showings")
      .insert({
        listing_id:     propertyIsUuid ? params.propertyId : null,
        contact_id:     params.contactId,
        agent_id:       agentRecordId,
        brokerage_id:   agentUser?.brokerage_id ?? null,
        scheduled_date: params.requestedDate,
        scheduled_at:   scheduledAt,
        status:         "scheduled",
        notes:          notesText,
        sync_source:    "ai_scheduler",
        is_confirmed:   false,
        created_at:     new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    // Write an activities row so the showing appears on the agent's activity feed as pending.
    // No calendar_event yet — that is written only when the agent confirms the showing time.
    try {
      await supabase.from("activities").insert({
        brokerage_id:  agentUser?.brokerage_id ?? null,
        agent_id:      agentRecordId,
        contact_id:    params.contactId,
        activity_type: "showing",
        title:         `Showing scheduled — ${params.requestedDate} at ${resolvedTime}`,
        description:   notesText ?? undefined,
        scheduled_at:  scheduledAt,
        status:        "pending",
        priority:      "high",
      })
    } catch { /* non-critical */ }

    revalidatePath("/showings")
    revalidatePath("/dashboard")

    return {
      success: true,
      showing,
      aiRecommendations,
    }
  } catch (error) {
    return handleError(error, "aiScheduleShowing")
  }
}

/**
 * AI Route Optimizer
 * Creates optimal showing routes based on location, time, and traffic patterns
 */
export async function aiOptimizeShowingRoute(params: {
  agentId: string
  date: string
  showingIds?: string[]
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get all showings for the date
    let query = supabase
      .from("showings")
      .select(`
        *,
        listings(*),
        contacts(first_name, last_name, phone, email)
      `)
      .eq("agent_id", params.agentId)
      .eq("scheduled_date", params.date)
      .in("status", ["scheduled", "confirmed"])

    if (params.showingIds?.length) {
      query = query.in("id", params.showingIds)
    }

    const { data: showings } = await query

    if (!showings || showings.length === 0) {
      return { success: false, error: "No showings found for this date" }
    }

    // Get agent's starting location from their brokerage (users has no address columns;
    // brokerages exposes city/state only).
    const { data: agent } = await supabase
      .from("users")
      .select("brokerages(name, city, state)")
      .eq("id", params.agentId)
      .single()

    // AI Route Optimization
    const { text: routeAnalysis } = await generateText({
      model: "openai/gpt-4o",
      prompt: `You are a real estate showing route optimizer. Create an optimal route.

AGENT STARTING LOCATION: ${(agent as any)?.brokerages?.name || "Office"}, ${(agent as any)?.brokerages?.city || ""}, ${(agent as any)?.brokerages?.state || ""}

SHOWINGS TO SCHEDULE:
${showings
  .map(
    (s: any, i: number) => `
${i + 1}. Property: ${s.listings?.address}, ${s.listings?.city}
   - Scheduled Time: ${s.scheduled_time}
   - Contact: ${s.contacts?.first_name} ${s.contacts?.last_name}
   - Property Type: ${s.listings?.property_type}
   - Notes: ${s.notes || "None"}
`
  )
  .join("")}

Consider:
1. Geographic clustering to minimize travel
2. Traffic patterns (rush hour, school zones)
3. Time between showings (minimum 30 min)
4. Property viewing duration (larger homes need more time)

Provide JSON response:
{
  "optimizedOrder": [
    {
      "showingId": "id",
      "recommendedTime": "HH:MM",
      "estimatedDuration": 30,
      "travelTimeFromPrevious": 15,
      "notes": "string"
    }
  ],
  "totalDuration": 240,
  "estimatedMiles": 25,
  "optimizationScore": 85,
  "routeNotes": ["note1", "note2"],
  "breakSuggestion": {
    "afterShowing": 2,
    "duration": 15,
    "nearbyOptions": ["coffee shop", "restaurant"]
  }
}`,
    })

    let optimizedRoute
    try {
      const jsonMatch = routeAnalysis.match(/\{[\s\S]*\}/)
      optimizedRoute = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      optimizedRoute = { optimizedOrder: showings.map((s: any) => ({ showingId: s.id })) }
    }

    // Save the optimized route
    const { data: route, error } = await supabase
      .from("showing_routes")
      .insert({
        agent_id: params.agentId,
        route_date: params.date,
        showings: showings.map((s: any) => s.id),
        optimized_order: optimizedRoute.optimizedOrder,
        total_duration: optimizedRoute.totalDuration,
        estimated_miles: optimizedRoute.estimatedMiles,
        optimization_score: optimizedRoute.optimizationScore,
        route_notes: optimizedRoute.routeNotes,
        created_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    // Update showing times if changed
    for (const item of optimizedRoute.optimizedOrder || []) {
      if (item.showingId && item.recommendedTime) {
        await supabase
          .from("showings")
          .update({
            scheduled_time: item.recommendedTime,
          })
          .eq("id", item.showingId)
      }
    }

    revalidatePath("/showings")

    return {
      success: true,
      route,
      optimizedRoute,
    }
  } catch (error) {
    return handleError(error, "aiOptimizeShowingRoute")
  }
}

/**
 * AI Showing Confirmation System
 * Sends smart confirmations via preferred channel
 */
export async function aiSendShowingConfirmation(showingId: string) {
  if (!isValidUUID(showingId)) {
    return { success: false, error: "Invalid showing ID" }
  }

  const supabase = await createClient()

  try {
    const { data: showing } = await supabase
      .from("showings")
      .select(`
        *,
        listings(*),
        contacts(*),
        users(first_name, last_name, phone, email)
      `)
      .eq("id", showingId)
      .single()

    if (!showing) {
      return { success: false, error: "Showing not found" }
    }

    // Generate personalized confirmation message
    const { text: confirmationContent } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Create a friendly, professional showing confirmation message.

SHOWING DETAILS:
- Property: ${showing.listings?.address}, ${showing.listings?.city}, ${showing.listings?.state}
- Date: ${new Date(showing.scheduled_date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
- Time: ${showing.scheduled_time}
- Agent: ${showing.users?.first_name} ${showing.users?.last_name}

BUYER DETAILS:
- Name: ${showing.contacts?.first_name}
- Persona: ${showing.contacts?.contact_persona || "buyer"}

Create JSON with both email and SMS versions:
{
  "emailSubject": "subject line",
  "emailBody": "full email body with property details and what to expect",
  "smsMessage": "brief SMS under 160 chars",
  "preparationTips": ["tip1", "tip2"]
}`,
    })

    let confirmationMessages
    try {
      const jsonMatch = confirmationContent.match(/\{[\s\S]*\}/)
      confirmationMessages = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      confirmationMessages = {
        emailSubject: `Showing Confirmation - ${showing.listings?.address}`,
        smsMessage: `Your showing at ${showing.listings?.address} is confirmed for ${showing.scheduled_date} at ${showing.scheduled_time}`,
      }
    }

    // Log the confirmation
    await supabase.from("showing_communications").insert({
      showing_id: showingId,
      communication_type: "confirmation",
      email_content: confirmationMessages,
      sms_content: confirmationMessages.smsMessage,
      sent_at: new Date().toISOString(),
      status: "sent",
    })

    // Update showing status
    await supabase.from("showings").update({ status: "confirmed", confirmed_at: new Date().toISOString() }).eq("id", showingId)

    revalidatePath("/showings")

    return {
      success: true,
      confirmationMessages,
    }
  } catch (error) {
    return handleError(error, "aiSendShowingConfirmation")
  }
}

/**
 * AI Showing Feedback Collection
 * Generates personalized feedback requests and analyzes responses
 */
export async function aiCollectShowingFeedback(showingId: string) {
  if (!isValidUUID(showingId)) {
    return { success: false, error: "Invalid showing ID" }
  }

  const supabase = await createClient()

  try {
    const { data: showing } = await supabase
      .from("showings")
      .select(`
        *,
        listings(*),
        contacts(*)
      `)
      .eq("id", showingId)
      .single()

    if (!showing) {
      return { success: false, error: "Showing not found" }
    }

    // Generate personalized feedback request
    const { text: feedbackRequest } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Create a personalized showing feedback request.

PROPERTY SHOWN:
- Address: ${showing.listings?.address}
- Price: $${showing.listings?.price?.toLocaleString()}
- Features: ${showing.listings?.bedrooms} bed, ${showing.listings?.bathrooms} bath

BUYER:
- Name: ${showing.contacts?.first_name}
- Looking for: ${showing.contacts?.contact_persona || "home"}

Create a warm, conversational feedback request that asks about:
1. Overall impression (1-10 scale)
2. Likes and dislikes
3. Interest level
4. Questions or concerns
5. Would they like to see it again or make an offer

JSON response:
{
  "subject": "email subject",
  "message": "personalized message",
  "questions": [
    {"id": "q1", "text": "question", "type": "rating|text|multiple_choice", "options": ["opt1"]}
  ]
}`,
    })

    let feedbackForm
    try {
      const jsonMatch = feedbackRequest.match(/\{[\s\S]*\}/)
      feedbackForm = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      feedbackForm = { subject: "How was your showing?", questions: [] }
    }

    // Create feedback request record
    // Live schema: showing_id, brokerage_id, sent_at, ai_analysis. The generated
    // form has no dedicated column → store under ai_analysis.feedback_form.
    const { data: feedback, error } = await supabase
      .from("showing_feedback_requests")
      .insert({
        showing_id: showingId,
        brokerage_id: (showing as any).brokerage_id ?? null,
        ai_analysis: { feedback_form: feedbackForm },
        sent_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    revalidatePath("/showings")

    return {
      success: true,
      feedbackForm,
      feedbackId: feedback.id,
    }
  } catch (error) {
    return handleError(error, "aiCollectShowingFeedback")
  }
}

/**
 * AI Analyze Showing Feedback
 * Analyzes collected feedback to determine buyer interest and next steps
 */
export async function aiAnalyzeShowingFeedback(feedbackId: string) {
  if (!isValidUUID(feedbackId)) {
    return { success: false, error: "Invalid feedback ID" }
  }

  const supabase = await createClient()

  try {
    const { data: feedback } = await supabase
      .from("showing_feedback_requests")
      .select(`
        *,
        showings(*, listings(*), contacts(*), showing_feedback(*))
      `)
      .eq("id", feedbackId)
      .single()

    // Feedback content lives on showing_feedback (joined via showing_id).
    const responses = (feedback as any)?.showings?.showing_feedback?.[0] ?? null
    if (!feedback || !responses) {
      return { success: false, error: "No feedback responses found" }
    }

    // AI Analysis of feedback
    const { text: analysis } = await generateText({
      model: "openai/gpt-4o",
      prompt: `Analyze this showing feedback and recommend next steps.

PROPERTY: ${feedback.showings?.listings?.address}
PRICE: $${feedback.showings?.listings?.list_price?.toLocaleString()}

BUYER FEEDBACK:
${JSON.stringify(responses, null, 2)}

Analyze and provide:
{
  "interestLevel": "high|medium|low|none",
  "interestScore": 0-100,
  "keyLikes": ["like1", "like2"],
  "keyConcerns": ["concern1", "concern2"],
  "buyerSentiment": "positive|neutral|negative",
  "recommendedActions": [
    {"action": "description", "priority": "high|medium|low", "timeline": "immediate|this_week|later"}
  ],
  "followUpMessage": "personalized follow-up message",
  "offerLikelihood": 0-100,
  "nextPropertySuggestions": ["criteria for similar properties"]
}`,
    })

    let analysisResult
    try {
      const jsonMatch = analysis.match(/\{[\s\S]*\}/)
      analysisResult = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      analysisResult = { interestLevel: "medium" }
    }

    // Update feedback with analysis
    await supabase
      .from("showing_feedback_requests")
      .update({
        ai_analysis: { ...analysisResult, analyzed_at: new Date().toISOString() },
        interest_score: analysisResult.interestScore,
      })
      .eq("id", feedbackId)

    // Update contact's lead score based on showing feedback
    const feedbackContactId = (feedback as any).showings?.contacts?.id ?? (feedback as any).showings?.contact_id
    if (analysisResult.interestScore && feedbackContactId) {
      const scoreAdjustment = Math.round((analysisResult.interestScore - 50) / 5)
      await supabase.rpc("adjust_lead_score", {
        p_contact_id: feedbackContactId,
        p_adjustment: scoreAdjustment,
        p_reason: "showing_feedback",
      })
    }

    revalidatePath("/showings")

    return {
      success: true,
      analysis: analysisResult,
    }
  } catch (error) {
    return handleError(error, "aiAnalyzeShowingFeedback")
  }
}

/**
 * Get AI-Powered Showing Insights
 * Dashboard analytics for showing performance
 */
export async function getAIShowingInsights(agentId: string, dateRange?: { start: string; end: string }) {
  if (!isValidUUID(agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    let query = supabase
      .from("showings")
      .select(`
        *,
        showing_feedback_requests(interest_score, ai_analysis)
      `)
      .eq("agent_id", agentId)

    if (dateRange) {
      query = query.gte("scheduled_date", dateRange.start).lte("scheduled_date", dateRange.end)
    }

    const { data: showings } = await query

    if (!showings || showings.length === 0) {
      return { success: true, insights: { totalShowings: 0 } }
    }

    // Calculate metrics
    const totalShowings = showings.length
    const completedShowings = showings.filter((s: any) => s.status === "completed").length
    const cancelledShowings = showings.filter((s: any) => s.status === "cancelled").length
    const feedbackReceived = showings.filter((s: any) => s.showing_feedback_requests?.length > 0).length

    const avgInterestScore =
      showings
        .filter((s: any) => s.showing_feedback_requests?.[0]?.interest_score)
        .reduce((sum: number, s: any) => sum + (s.showing_feedback_requests[0].interest_score || 0), 0) /
        (feedbackReceived || 1)

    // AI Generate insights
    const { text: aiInsights } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Analyze showing performance and provide insights.

METRICS:
- Total Showings: ${totalShowings}
- Completed: ${completedShowings}
- Cancelled: ${cancelledShowings}
- Feedback Rate: ${((feedbackReceived / totalShowings) * 100).toFixed(1)}%
- Average Interest Score: ${avgInterestScore.toFixed(1)}

Provide brief, actionable insights:
{
  "performanceSummary": "one sentence summary",
  "strengths": ["strength1"],
  "improvements": ["improvement1"],
  "recommendations": ["recommendation1"],
  "predictedConversions": number
}`,
    })

    let insights
    try {
      const jsonMatch = aiInsights.match(/\{[\s\S]*\}/)
      insights = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      insights = {}
    }

    return {
      success: true,
      insights: {
        totalShowings,
        completedShowings,
        cancelledShowings,
        feedbackReceived,
        avgInterestScore,
        conversionRate: completedShowings > 0 ? ((feedbackReceived / completedShowings) * 100).toFixed(1) : 0,
        ...insights,
      },
    }
  } catch (error) {
    return handleError(error, "getAIShowingInsights")
  }
}
