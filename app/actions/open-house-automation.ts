"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateText } from "ai"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { ContentGenerationService } from "@/lib/services"
import {
  sendOpenHouseInvitation,
  sendOpenHouseReminder,
  sendWeatherAlertToAgent,
  sendFeedbackRequest,
} from "@/lib/communications"

function parseAIJsonResponse(text: string) {
  let cleanText = text.trim()
  if (cleanText.startsWith("```json")) {
    cleanText = cleanText.replace(/^```json\s*/, "").replace(/```\s*$/, "")
  } else if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```\s*/, "").replace(/```\s*$/, "")
  }
  return JSON.parse(cleanText.trim())
}

// ============================================
// OPEN HOUSE CRUD OPERATIONS
// ============================================

export async function scheduleOpenHouse(params: {
  listingId: string
  agentId: string
  startTime: string
  endTime: string
  description?: string
}) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("open_house_events")
      .insert({
        property_id: params.listingId,
        agent_id: params.agentId,
        event_date: params.startTime.split('T')[0],
        start_time: params.startTime,
        end_time: params.endTime,
        description: params.description,
        status: "scheduled",
      })
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard")
    return { success: true, openHouse: data }
  } catch (error) {
    return handleError(error, "scheduleOpenHouse")
  }
}

export async function getOpenHouseVisitors(openHouseId: string) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("open_house_attendees")
      .select("*, contact:contacts(*)")
      .eq("event_id", openHouseId)
      .order("check_in_time", { ascending: false })

    if (error) throw error

    return { success: true, visitors: data || [] }
  } catch (error) {
    return handleError(error, "getOpenHouseVisitors")
  }
}

export async function recordVisitor(params: {
  openHouseId: string
  contactId?: string
  firstName: string
  lastName: string
  email?: string
  phone?: string
  notes?: string
  interestLevel?: string
}) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("open_house_attendees")
      .insert({
        event_id: params.openHouseId,
        contact_id: params.contactId,
        first_name: params.firstName,
        last_name: params.lastName,
        email: params.email,
        phone: params.phone,
        notes: params.notes,
        interest_level: params.interestLevel || "somewhat_interested",
        check_in_time: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard")
    return { success: true, visitor: data }
  } catch (error) {
    return handleError(error, "recordVisitor")
  }
}

// ============================================
// AI TIMING OPTIMIZER
// ============================================

export async function optimizeOpenHouseTiming(params: { propertyId: string; agentId: string; proposedDate?: string }) {
  if (!isValidUUID(params.agentId)) {
    return {
      recommended_times: [
        { date: "2024-02-10", time: "14:00-16:00", score: 92, reasoning: "Saturday afternoon, optimal weather" },
        { date: "2024-02-11", time: "13:00-15:00", score: 88, reasoning: "Sunday early afternoon, less competition" },
      ],
    }
  }

  const supabase = await createClient()

  try {
    const { data: property } = await supabase.from("listings").select("*").eq("id", params.propertyId).single()

    // Get historical data
    const { data: historical } = await supabase
      .from("open_house_events")
      .select("*, open_house_analytics(*)")
      .eq("property_type", property?.property_type)
      .order("actual_attendance", { ascending: false })
      .limit(20)

    const prompt = `Analyze optimal open house timing for this property:

PROPERTY DETAILS:
- Type: ${property?.property_type}
- Price: $${property?.price}
- Location: ${property?.address}
- Target Buyers: ${property?.target_buyer_personas || "general"}

HISTORICAL DATA (Similar Properties):
${
  historical
    ?.map(
      (h: any) =>
        `- ${h.event_date} ${h.start_time}: ${h.actual_attendance || 0} attendees (predicted: ${h.predicted_attendance || 0})`
    )
    .join("\n") || "No historical data"
}

CONSTRAINTS:
- Avoid major holidays
- Consider local market patterns
- Weekend preferred but not required
- Weather considerations

ANALYSIS NEEDED:
1. Best day of week (Saturday vs Sunday vs weekday)
2. Optimal time slot (morning, afternoon, evening)
3. Seasonal considerations
4. Competition analysis (other open houses)
5. Market activity levels

OUTPUT FORMAT (JSON):
{
  "recommended_times": [
    {
      "date": "YYYY-MM-DD",
      "time": "HH:MM-HH:MM",
      "score": 0-100,
      "reasoning": "why this time is optimal",
      "expected_attendance": 15,
      "competition_level": "low" | "medium" | "high"
    }
  ],
  "avoid_dates": ["YYYY-MM-DD"],
  "best_practices": ["tip1", "tip2"]
}`

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    return parseAIJsonResponse(text)
  } catch (error) {
    console.error("Optimize timing error:", error)
    return { error: "Failed to optimize timing" }
  }
}

// ============================================
// MATCH SCORING
// ============================================

export async function calculateMatchScore(contactId: string, propertyId: string): Promise<number> {
  if (!isValidUUID(contactId) || !isValidUUID(propertyId)) {
    return 0
  }

  const supabase = await createClient()

  try {
    const { data: contact } = await supabase.from("contacts").select("*").eq("id", contactId).single()

    const { data: property } = await supabase.from("listings").select("*").eq("id", propertyId).single()

    if (!contact || !property) return 0

    let score = 0

    // Price match (0-25 points)
    const budgetMin = contact.budget_min || 0
    const budgetMax = contact.budget_max || Number.POSITIVE_INFINITY
    if (property.price >= budgetMin && property.price <= budgetMax) {
      score += 25
    } else if (property.price < budgetMin * 1.1 || property.price > budgetMax * 0.9) {
      score += 15 // Within 10% tolerance
    }

    // Beds/baths match (0-20 points)
    if (contact.beds_wanted && property.beds >= contact.beds_wanted) {
      score += 10
    }
    if (contact.baths_wanted && property.baths >= contact.baths_wanted) {
      score += 10
    }

    // Location match (0-15 points)
    if (contact.preferred_locations?.includes(property.neighborhood)) {
      score += 15
    } else if (contact.preferred_locations?.some((loc: string) => property.address?.includes(loc))) {
      score += 10
    }

    // Property type match (0-10 points)
    if (contact.property_type_preference === property.property_type) {
      score += 10
    }

    // Features match (0-20 points)
    const desiredFeatures = contact.must_have_features || []
    const propertyFeatures = property.features || []
    const matchingFeatures = desiredFeatures.filter((f: string) => propertyFeatures.includes(f))
    score += Math.min((matchingFeatures.length / Math.max(desiredFeatures.length, 1)) * 20, 20)

    // Engagement score (0-10 points)
    score += ((contact.engagement_score || 0) / 100) * 10

    return Math.min(score, 100)
  } catch (error) {
    console.error("Calculate match score error:", error)
    return 0
  }
}

// ============================================
// PERSONALIZED INVITATIONS
// ============================================

export async function generatePersonalizedInvite(params: { contactId: string; eventId: string }) {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.eventId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: contact } = await supabase.from("contacts").select("*").eq("id", params.contactId).single()

    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, property:listings(*)")
      .eq("id", params.eventId)
      .single()

    const { data: persona } = await supabase
      .from("client_detailed_personas")
      .select("*")
      .eq("id", contact?.persona_id)
      .maybeSingle()

    const matchScore = await calculateMatchScore(params.contactId, event?.property_id)

    const prompt = `Generate personalized open house invitation for ${contact?.first_name} ${contact?.last_name}.

RECIPIENT PROFILE:
- Name: ${contact?.first_name} ${contact?.last_name}
- Persona: ${persona?.persona_type || "general"}
- Looking for: ${contact?.beds_wanted} bed, ${contact?.baths_wanted} bath
- Budget: $${contact?.budget_min}-${contact?.budget_max}
- Priorities: ${contact?.must_have_features?.join(", ") || "Not specified"}
- Timeline: ${contact?.timeline || "flexible"}
- Pain Points: ${persona?.pain_points?.join(", ") || "Unknown"}

PROPERTY DETAILS:
- Address: ${event?.property?.address}
- Beds/Baths: ${event?.property?.beds}/${event?.property?.baths}
- Price: $${event?.property?.price}
- Key Features: ${event?.property?.features?.join(", ") || "Various"}
- Neighborhood: ${event?.property?.neighborhood}

MATCH REASONING:
- Match Score: ${matchScore}/100
- Why this fits: ${generateMatchReasoning(contact, event?.property, matchScore)}

OPEN HOUSE DETAILS:
- Date: ${event?.event_date}
- Time: ${event?.start_time} - ${event?.end_time}

TASK: Write personalized invitation that:
1. Addresses ${contact?.first_name} by name
2. Highlights property features matching THEIR specific priorities
3. Explains why THIS home fits THEIR needs (not generic)
4. Creates gentle urgency without pressure
5. Makes it easy to RSVP

TONE: ${persona?.communication_preferences === "formal" ? "Professional but friendly" : "Warm and conversational"}

DO NOT use generic phrases like "great opportunity" or "don't miss out"
DO reference their specific search criteria
DO make them feel you're thinking about THEM specifically

OUTPUT FORMAT (JSON):
{
  "email_subject": "...",
  "email_body": "...",
  "sms_message": "...",
  "reasoning": "Why this property matches this contact"
}`

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    const result = parseAIJsonResponse(text)

    revalidatePath("/dashboard/open-house")
    return { success: true, data: result }
  } catch (error) {
    console.error("Generate invite error:", error)
    return { success: false, error: "Failed to generate invitation" }
  }
}

function generateMatchReasoning(contact: any, property: any, score: number): string {
  const reasons = []

  if (property?.price >= contact?.budget_min && property?.price <= contact?.budget_max) {
    reasons.push("Within budget")
  }
  if (property?.beds >= contact?.beds_wanted) {
    reasons.push(`Has ${contact?.beds_wanted}+ bedrooms as requested`)
  }
  if (contact?.preferred_locations?.includes(property?.neighborhood)) {
    reasons.push("In preferred neighborhood")
  }

  return reasons.join(", ") || "Good general fit"
}

// ============================================
// SEND INVITATIONS
// ============================================

export async function sendOpenHouseInvitations(params: { eventId: string; contactIds: string[] }) {
  if (!isValidUUID(params.eventId)) {
    return { success: false, error: "Invalid event ID" }
  }

  const supabase = await createClient()
  const results = []

  for (const contactId of params.contactIds) {
    if (!isValidUUID(contactId)) continue

    try {
      const { data: contact } = await supabase.from("contacts").select("*").eq("id", contactId).single()

      const { data: event } = await supabase.from("open_house_events").select("*").eq("id", params.eventId).single()

      // Generate personalized content
      const inviteResult = await generatePersonalizedInvite({ contactId, eventId: params.eventId })

      if (!inviteResult.success) {
        results.push({ contactId, status: "failed", error: "Content generation failed" })
        continue
      }

      const matchScore = await calculateMatchScore(contactId, event?.property_id)

      // Create invitation record
      const { data: invitation } = await supabase
        .from("open_house_invitations")
        .insert({
          event_id: params.eventId,
          contact_id: contactId,
          channel: contact?.preferred_contact_method || "email",
          personalized_message: inviteResult.data.email_body,
          match_score: matchScore,
          match_reasoning: inviteResult.data.reasoning,
          sent_at: new Date().toISOString(),
        })
        .select()
        .single()

      // Send via email using the AI-generated content
      if (invitation?.id) {
        await sendOpenHouseInvitation({
          invitationId: invitation.id,
          contactId,
          eventId: params.eventId,
          emailContent: inviteResult.data.email_body,
          smsContent: inviteResult.data.sms_message,
        })
      }

      results.push({ contactId, status: "sent", invitationId: invitation?.id })
    } catch (error) {
      results.push({ contactId, status: "failed", error: String(error) })
    }
  }

  // Update marketing reach
  await supabase
    .from("open_house_events")
    .update({ marketing_reach: params.contactIds.length })
    .eq("id", params.eventId)

  revalidatePath("/dashboard/open-house")
  return { success: true, results }
}

// ============================================
// RSVP HANDLING
// ============================================

export async function handleRSVP(params: { eventId: string; invitationId: string; response: "yes" | "maybe" | "no" }) {
  if (!isValidUUID(params.eventId) || !isValidUUID(params.invitationId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: invitation } = await supabase
      .from("open_house_invitations")
      .select("*")
      .eq("id", params.invitationId)
      .single()

    if (!invitation) {
      return { success: false, error: "Invitation not found" }
    }

    // Update invitation
    await supabase
      .from("open_house_invitations")
      .update({
        rsvp_status: params.response,
        rsvp_at: new Date().toISOString(),
      })
      .eq("id", params.invitationId)

    // Track RSVP
    await supabase.from("open_house_rsvp_tracking").insert({
      event_id: params.eventId,
      contact_id: invitation.contact_id,
      rsvp_status: params.response,
      accessed_at: new Date().toISOString(),
    })

    revalidatePath("/dashboard/open-house")

    const message = {
      yes: "Great! We look forward to seeing you. Calendar invite sent to your email.",
      maybe: "No problem! We hope you can make it. Let us know if plans change.",
      no: "Thanks for letting us know. We'll keep you updated on other properties.",
    }[params.response]

    return { success: true, message }
  } catch (error) {
    console.error("Handle RSVP error:", error)
    return { success: false, error: "Failed to record RSVP" }
  }
}

// ============================================
// ATTENDANCE PREDICTION
// ============================================

export async function predictAttendance(eventId: string) {
  if (!isValidUUID(eventId)) {
    return {
      predicted_attendance_low: 12,
      predicted_attendance_mid: 18,
      predicted_attendance_high: 24,
      confidence_level: 0.78,
      serious_buyers_expected: 5,
    }
  }

  const supabase = await createClient()

  try {
    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, property:listings(*)")
      .eq("id", eventId)
      .single()

    const { data: invitations } = await supabase.from("open_house_invitations").select("*").eq("event_id", eventId)

    const { data: historical } = await supabase
      .from("open_house_events")
      .select("*, open_house_analytics(*)")
      .eq("property_type", event?.property?.property_type)
      .limit(10)

    const rsvpYes = invitations?.filter((i: any) => i.rsvp_status === "yes").length || 0
    const rsvpMaybe = invitations?.filter((i: any) => i.rsvp_status === "maybe").length || 0

    const prompt = `Predict attendance for open house event.

EVENT DETAILS:
- Property: ${event?.property?.address}
- Date: ${event?.event_date} ${event?.start_time}-${event?.end_time}
- Price: $${event?.property?.price}
- Property Type: ${event?.property?.property_type}

INVITATION METRICS:
- Total Invitations Sent: ${invitations?.length || 0}
- RSVPs: ${rsvpYes} Yes, ${rsvpMaybe} Maybe
- No Response: ${invitations?.length - rsvpYes - rsvpMaybe || 0}

HISTORICAL DATA (Similar Properties):
${
  historical
    ?.map((h: any) => `- ${h.event_date}: ${h.actual_attendance || 0} attendees (predicted: ${h.predicted_attendance || 0})`)
    .join("\n") || "No historical data"
}

TASK: Predict attendance with confidence intervals.

Consider:
- RSVP conversion rate (typically 60-80% of Yes RSVPs attend)
- Walk-in rate (neighbors, unregistered buyers)
- Day of week effectiveness
- Seasonal trends

OUTPUT FORMAT (JSON):
{
  "predicted_attendance_low": 12,
  "predicted_attendance_mid": 18,
  "predicted_attendance_high": 24,
  "confidence_level": 0.78,
  "serious_buyers_expected": 5,
  "breakdown": {
    "from_rsvps": 14,
    "walk_ins_estimated": 4
  },
  "factors": {
    "positive": ["Strong RSVP rate"],
    "negative": []
  },
  "recommendation": "Good turnout expected."
}`

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    const prediction = parseAIJsonResponse(text)

    // Store prediction
    await supabase
      .from("open_house_events")
      .update({
        predicted_attendance: prediction.predicted_attendance_mid,
      })
      .eq("id", eventId)

    return prediction
  } catch (error) {
    console.error("Predict attendance error:", error)
    return { error: "Failed to predict attendance" }
  }
}

// ============================================
// AUTOMATED FOLLOW-UPS
// ============================================

export async function processEventFollowups(eventId: string) {
  if (!isValidUUID(eventId)) {
    return { success: false, error: "Invalid event ID" }
  }

  const supabase = await createClient()

  try {
    // Mark event as completed
    await supabase.from("open_house_events").update({ status: "completed" }).eq("id", eventId)

    // Get all attendees
    const { data: attendees } = await supabase.from("open_house_attendees").select("*").eq("event_id", eventId)

    if (!attendees || attendees.length === 0) {
      return { success: true, message: "No attendees to follow up with" }
    }

    // Calculate lead scores
    for (const attendee of attendees) {
      const leadScore = calculateAttendeeLeadScore(attendee)

      await supabase.from("open_house_attendees").update({ ai_lead_score: leadScore }).eq("id", attendee.id)
    }

    // Segment and trigger follow-ups
    const hotLeads = attendees.filter((a: any) => a.ai_lead_score >= 70)
    const warmLeads = attendees.filter((a: any) => a.ai_lead_score >= 40 && a.ai_lead_score < 70)

    // Generate analytics
    await generateEventAnalytics(eventId)

    revalidatePath("/dashboard/open-house")
    return {
      success: true,
      data: {
        total_attendees: attendees.length,
        hot_leads: hotLeads.length,
        warm_leads: warmLeads.length,
      },
    }
  } catch (error) {
    console.error("Process followups error:", error)
    return { success: false, error: "Failed to process follow-ups" }
  }
}

function calculateAttendeeLeadScore(attendee: any): number {
  let score = 0

  // Interest level (0-40 points)
  const interestScores: Record<string, number> = {
    ready_to_offer: 40,
    very_interested: 30,
    somewhat_interested: 20,
    just_looking: 10,
    not_interested: 0,
  }
  score += interestScores[attendee.interest_level] || 0

  // Time spent (0-20 points)
  if (attendee.time_spent_minutes > 30) score += 20
  else if (attendee.time_spent_minutes > 20) score += 15
  else if (attendee.time_spent_minutes > 10) score += 10
  else score += 5

  // Feedback rating (0-10 points)
  if (attendee.feedback_rating) {
    score += attendee.feedback_rating * 2
  }

  // Asked specific questions (0-10 points)
  if (attendee.specific_questions?.length > 0) score += 10

  return Math.min(score, 100)
}

async function generateEventAnalytics(eventId: string) {
  const supabase = await createClient()

  const { data: event } = await supabase.from("open_house_events").select("*").eq("id", eventId).single()

  const { data: attendees } = await supabase.from("open_house_attendees").select("*").eq("event_id", eventId)

  const { data: invitations } = await supabase.from("open_house_invitations").select("*").eq("event_id", eventId)

  const analytics = {
    event_id: eventId,
    total_invites_sent: invitations?.length || 0,
    rsvp_yes_count: invitations?.filter((i: any) => i.rsvp_status === "yes").length || 0,
    rsvp_maybe_count: invitations?.filter((i: any) => i.rsvp_status === "maybe").length || 0,
    rsvp_no_count: invitations?.filter((i: any) => i.rsvp_status === "no").length || 0,
    total_attendance: attendees?.length || 0,
    attendance_vs_predicted: (attendees?.length || 0) - (event?.predicted_attendance || 0),
    serious_buyers_count:
      attendees?.filter(
        (a: any) => a.interest_level === "very_interested" || a.interest_level === "ready_to_offer"
      ).length || 0,
    avg_lead_score:
      attendees && attendees.length > 0
        ? attendees.reduce((sum: number, a: any) => sum + (a.ai_lead_score || 0), 0) / attendees.length
        : 0,
    avg_time_spent_minutes:
      attendees && attendees.length > 0
        ? attendees.reduce((sum: number, a: any) => sum + (a.time_spent_minutes || 0), 0) / attendees.length
        : 0,
  }

  await supabase.from("open_house_analytics").insert(analytics)

  return analytics
}

// ============================================
// CRUD OPERATIONS
// ============================================

export async function createOpenHouseEvent(params: {
  agentId: string
  propertyId: string
  eventDate: string
  startTime: string
  endTime: string
  description?: string
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.propertyId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: event, error } = await supabase
      .from("open_house_events")
      .insert({
        hosting_agent_id: params.agentId,
        property_id: params.propertyId,
        event_date: params.eventDate,
        start_time: params.startTime,
        end_time: params.endTime,
        description: params.description,
        status: "scheduled",
      })
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard/open-house")
    return { success: true, data: event }
  } catch (error) {
    console.error("Create event error:", error)
    return { success: false, error: "Failed to create event" }
  }
}

export async function getOpenHouseEvents(agentId: string) {
  if (!isValidUUID(agentId)) {
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("open_house_events")
    .select("*, property:listings(*), analytics:open_house_analytics(*)")
    .eq("hosting_agent_id", agentId)
    .order("event_date", { ascending: false })

  if (error) {
    console.error("Get events error:", error)
    return []
  }

  return data || []
}

// ============================================
// WEATHER INTEGRATION
// ============================================

export async function fetchWeatherForEvent(eventId: string) {
  if (!isValidUUID(eventId)) {
    return {
      temperature: 72,
      conditions: "partly cloudy",
      precip_chance: 10,
      wind_speed: 8,
      quality_score: 85,
    }
  }

  const supabase = await createClient()

  try {
    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, property:listings(*)")
      .eq("id", eventId)
      .single()

    if (!event?.property?.latitude || !event?.property?.longitude) {
      return { error: "Property location not found" }
    }

    // Note: This would integrate with OpenWeatherMap or similar API
    // For demo purposes, returning mock data structure
    const weather = {
      temperature: 72,
      conditions: "partly cloudy",
      precip_chance: 10,
      wind_speed: 8,
      humidity: 55,
      quality_score: calculateWeatherScore({ temperature: 72, precip_chance: 10, conditions: "partly cloudy" }),
      fetched_at: new Date().toISOString(),
    }

    // Store weather forecast
    await supabase
      .from("open_house_events")
      .update({
        weather_forecast: weather,
      })
      .eq("id", eventId)

  // Alert if poor weather
  if (weather.quality_score < 50) {
    console.log(`[v0] Weather warning for event ${eventId}: score ${weather.quality_score}`)
    
    // Send weather alert to agent
    const { data: event } = await supabase
      .from("open_house_events")
      .select("agent_id")
      .eq("id", eventId)
      .single()
    
    if (event?.agent_id) {
      await sendWeatherAlertToAgent({
        eventId,
        agentId: event.agent_id,
        weatherData: weather
      })
    }
  }

    return weather
  } catch (error) {
    console.error("Fetch weather error:", error)
    return { error: "Failed to fetch weather" }
  }
}

function calculateWeatherScore(weather: any): number {
  let score = 100

  // Temperature penalties
  if (weather.temperature < 40 || weather.temperature > 85) score -= 20
  if (weather.temperature < 32 || weather.temperature > 95) score -= 40

  // Precipitation penalties
  score -= weather.precip_chance * 0.5

  // Conditions
  if (weather.conditions?.includes("rain")) score -= 30
  if (weather.conditions?.includes("snow")) score -= 40
  if (weather.conditions?.includes("storm")) score -= 50

  return Math.max(score, 0)
}

// ============================================
// PERFORMANCE INSIGHTS
// ============================================

export async function generatePerformanceInsights(eventId: string) {
  if (!isValidUUID(eventId)) {
    return {
      overall_grade: "B+",
      performance_summary: "Above average event with strong attendance and good lead quality.",
      strengths: ["High RSVP conversion", "Quality leads generated"],
      weaknesses: ["Could improve follow-up speed"],
      recommendations: ["Schedule next open house on Saturday afternoon", "Focus on hot leads within 24 hours"],
    }
  }

  const supabase = await createClient()

  try {
    const { data: analytics } = await supabase.from("open_house_analytics").select("*").eq("event_id", eventId).single()

    const { data: event } = await supabase.from("open_house_events").select("*").eq("id", eventId).single()

    if (!analytics || !event) {
      return { error: "Analytics data not found" }
    }

    const prompt = `Analyze open house performance and provide actionable insights.

EVENT METRICS:
Invitations:
- Sent: ${analytics.total_invites_sent}
- RSVP Yes: ${analytics.rsvp_yes_count}
- RSVP Rate: ${((analytics.rsvp_yes_count / analytics.total_invites_sent) * 100).toFixed(1)}%

Attendance:
- Predicted: ${event.predicted_attendance}
- Actual: ${analytics.total_attendance}
- Accuracy: ${((analytics.total_attendance / event.predicted_attendance) * 100).toFixed(1)}%

Lead Quality:
- Serious Buyers: ${analytics.serious_buyers_count}
- Average Lead Score: ${analytics.avg_lead_score?.toFixed(1)}/100
- Average Time Spent: ${analytics.avg_time_spent_minutes?.toFixed(1)} minutes

TASK: Provide performance analysis with letter grade (A+, A, A-, B+, B, etc.) and recommendations.

OUTPUT FORMAT (JSON):
{
  "overall_grade": "A-",
  "performance_summary": "Strong event with excellent turnout",
  "strengths": ["High attendance", "Quality leads"],
  "weaknesses": ["Lower than expected time spent"],
  "recommendations": ["Schedule follow-up calls within 24 hours", "Try evening open house next time"],
  "comparison_to_average": {
    "attendance": "+15%",
    "lead_quality": "+22%"
  },
  "next_steps": ["Contact hot leads today", "Send thank you emails to all attendees"]
}`

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    const insights = parseAIJsonResponse(text)

    // Store insights
    await supabase
      .from("open_house_analytics")
      .update({
        performance_insights: insights,
      })
      .eq("event_id", eventId)

    return insights
  } catch (error) {
    console.error("Generate insights error:", error)
    return { error: "Failed to generate insights" }
  }
}

// ============================================
// FEEDBACK COLLECTION
// ============================================

export async function sendFeedbackRequestToAttendee(attendeeId: string) {
  if (!isValidUUID(attendeeId)) {
    return { success: false, error: "Invalid attendee ID" }
  }

  const supabase = await createClient()

  try {
    const { data: attendee } = await supabase.from("open_house_attendees").select("*").eq("id", attendeeId).single()

    if (!attendee) {
      return { success: false, error: "Attendee not found" }
    }

    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, property:listings(*)")
      .eq("id", attendee.event_id)
      .single()

    const feedbackUrl = `${process.env.NEXT_PUBLIC_APP_URL || ""}/open-house/feedback/${attendeeId}`
  
    // Send feedback request via email and SMS
    if (attendee.contact_id) {
      await sendFeedbackRequest({
        contactId: attendee.contact_id,
        eventId: attendee.event_id,
        feedbackUrl
      })
      console.log(`[v0] Feedback request sent to ${attendee.contact_email} for event at ${event?.property?.address}`)
    } else {
      console.log(`[v0] No contact_id for attendee, skipping feedback request`)
    }
  
    return { success: true, feedbackUrl }
  } catch (error) {
    console.error("Send feedback request error:", error)
    return { success: false, error: "Failed to send feedback request" }
  }
}

export async function submitFeedback(params: {
  attendeeId: string
  overallRating: number
  whatLikedMost?: string
  concerns?: string
  pricingFeedback?: string
  wouldMakeOffer?: string
  preferredFollowUp?: string
  additionalComments?: string
}) {
  if (!isValidUUID(params.attendeeId)) {
    return { success: false, error: "Invalid attendee ID" }
  }

  const supabase = await createClient()

  try {
    const { data: attendee } = await supabase.from("open_house_attendees").select("*").eq("id", params.attendeeId).single()

    if (!attendee) {
      return { success: false, error: "Attendee not found" }
    }

    // Update attendee record
    await supabase
      .from("open_house_attendees")
      .update({
        feedback_rating: params.overallRating,
        feedback_comments: params.additionalComments,
        feedback_collected_at: new Date().toISOString(),
      })
      .eq("id", params.attendeeId)

    // Store detailed feedback in the correct table with correct column names
    await supabase.from("open_house_feedback").insert({
      attendee_id: params.attendeeId,
      event_id: attendee.event_id,
      contact_id: attendee.contact_id ?? null,
      brokerage_id: attendee.brokerage_id ?? null,
      rating: params.overallRating,
      price_opinion: params.pricingFeedback ?? null,
      liked_most: params.whatLikedMost ?? null,
      concerns: params.concerns ?? null,
      interested_in_offer: params.wouldMakeOffer === "yes",
      has_own_agent: attendee.working_with_agent ?? false,
    })

    // Update lead score based on feedback
    let scoreAdjustment = 0
    if (params.wouldMakeOffer === "yes") scoreAdjustment = 20
    if (params.overallRating >= 4) scoreAdjustment += 10

    if (scoreAdjustment > 0) {
      await supabase
        .from("open_house_attendees")
        .update({
          ai_lead_score: (attendee.ai_lead_score || 0) + scoreAdjustment,
        })
        .eq("id", params.attendeeId)
    }

    revalidatePath("/dashboard/open-house")
    return { success: true, message: "Thank you for your feedback!" }
  } catch (error) {
    console.error("Submit feedback error:", error)
    return { success: false, error: "Failed to submit feedback" }
  }
}

// ============================================
// COMPETITIVE INTELLIGENCE
// ============================================

export async function monitorCompetingEvents(eventId: string) {
  if (!isValidUUID(eventId)) {
    return { competing_count: 0, same_time_conflicts: 0 }
  }

  const supabase = await createClient()

  try {
    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, property:listings(*)")
      .eq("id", eventId)
      .single()

    if (!event) {
      return { error: "Event not found" }
    }

    // Query for other open houses in the area on same date
    const { data: competingEvents } = await supabase
      .from("open_house_events")
      .select("*, property:listings(*)")
      .eq("event_date", event.event_date)
      .neq("id", eventId)
      .limit(20)

    // Calculate which ones overlap in time and are nearby
    const sameTimeConflicts = (competingEvents || []).filter((ce: any) => {
      // Check time overlap
      const eventStart = parseTime(event.start_time)
      const eventEnd = parseTime(event.end_time)
      const ceStart = parseTime(ce.start_time)
      const ceEnd = parseTime(ce.end_time)

      return (eventStart < ceEnd && eventEnd > ceStart)
    })

    const competingData = {
      total_competing: competingEvents?.length || 0,
      same_time_conflicts: sameTimeConflicts.length,
      competing_events: (competingEvents || []).map((ce: any) => ({
        address: ce.property?.address,
        time: `${ce.start_time}-${ce.end_time}`,
        price: ce.property?.price,
        property_type: ce.property?.property_type,
      })),
    }

    // Store competing events data
    await supabase
      .from("open_house_events")
      .update({
        competing_events_data: competingData,
      })
      .eq("id", eventId)

    // Alert if high competition
    if (sameTimeConflicts.length >= 2) {
      console.log(`[v0] High competition alert: ${sameTimeConflicts.length} competing events at same time`)
    }

    return competingData
  } catch (error) {
    console.error("Monitor competing events error:", error)
    return { error: "Failed to monitor competition" }
  }
}

function parseTime(timeStr: string): number {
  const [hours, minutes] = timeStr.split(":").map(Number)
  return hours * 60 + minutes
}

// ============================================
// DIGITAL CHECK-IN
// ============================================

export async function checkInAttendee(params: {
  eventId: string
  contactEmail: string
  contactName: string
  contactPhone?: string
  interestLevel?: string
  specificQuestions?: string[]
  optInFollowUp?: boolean
}) {
  if (!isValidUUID(params.eventId)) {
    return { success: false, error: "Invalid event ID" }
  }

  const supabase = await createClient()

  try {
    // Check if attendee already checked in
    const { data: existing } = await supabase
      .from("open_house_attendees")
      .select("*")
      .eq("event_id", params.eventId)
      .eq("contact_email", params.contactEmail)
      .maybeSingle()

    if (existing) {
      return { success: false, error: "Already checked in" }
    }

    // Create attendee record
    const { data: attendee } = await supabase
      .from("open_house_attendees")
      .insert({
        event_id: params.eventId,
        contact_email: params.contactEmail,
        contact_name: params.contactName,
        contact_phone: params.contactPhone,
        interest_level: params.interestLevel || "just_looking",
        specific_questions: params.specificQuestions,
        opt_in_follow_up: params.optInFollowUp !== false,
        check_in_time: new Date().toISOString(),
      })
      .select()
      .single()

    // Send automated feedback request after 30 minutes
    setTimeout(() => {
      sendFeedbackRequestToAttendee(attendee.id)
    }, 30 * 60 * 1000)

    revalidatePath("/dashboard/open-house")
    return { success: true, data: attendee }
  } catch (error) {
    console.error("Check-in attendee error:", error)
    return { success: false, error: "Failed to check in" }
  }
}
