"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"

// Get auto-response settings for the current user
export async function getAutoResponseSettings() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: "Not authenticated", settings: null }
  }

  const { data, error } = await supabase
    .from("auto_response_settings")
    .select("*")
    .eq("user_id", user.id)
    .single()

  if (error && error.code !== "PGRST116") {
    console.error("Error fetching auto-response settings:", error)
    return { success: false, error: error.message, settings: null }
  }

  // Return default settings if none exist
  if (!data) {
    return {
      success: true,
      settings: {
        enabled: false,
        auto_respond_to_new_leads: true,
        auto_respond_to_inquiries: true,
        business_hours_only: false,
        response_delay_minutes: 2,
        max_auto_responses_per_conversation: 3,
        tone: "professional",
        include_agent_signature: true,
      },
    }
  }

  return { success: true, settings: data }
}

// Update auto-response settings
export async function updateAutoResponseSettings(settings: {
  enabled: boolean
  auto_respond_to_new_leads?: boolean
  auto_respond_to_inquiries?: boolean
  business_hours_only?: boolean
  response_delay_minutes?: number
  max_auto_responses_per_conversation?: number
  tone?: string
  include_agent_signature?: boolean
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: "Not authenticated" }
  }

  const { error } = await supabase
    .from("auto_response_settings")
    .upsert({
      user_id: user.id,
      ...settings,
      updated_at: new Date().toISOString(),
    })

  if (error) {
    console.error("Error updating auto-response settings:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

// Generate AI response for a message
export async function generateAIResponse(params: {
  conversationId: string
  contactId: string
  lastMessage: string
  conversationHistory?: any[]
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: "Not authenticated", response: null }
  }

  // Get contact information for context
  const { data: contact } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", params.contactId)
    .single()

  // Get conversation history
  const { data: messages } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", params.conversationId)
    .order("created_at", { ascending: false })
    .limit(10)

  // Get auto-response settings
  const { settings } = await getAutoResponseSettings()

  // Build context for AI
  const context = {
    contactName: contact?.first_name
      ? `${contact.first_name} ${contact.last_name || ""}`
      : "there",
    contactType: contact?.contact_type || "unknown",
    lastMessage: params.lastMessage,
    conversationHistory: messages || [],
    tone: settings?.tone || "professional",
    agentName: user.user_metadata?.full_name || "our team",
  }

  // Generate AI response (placeholder - integrate with AI SDK)
  const aiResponse = await generateSmartReply(context)

  // Log the AI response
  const { agentId } = await getAgentContext()
  await supabase.from("messages").insert({
    conversation_id: params.conversationId,
    contact_id: params.contactId,
    agent_id: agentId,
    content: aiResponse,
    direction: "outbound",
    channel: "ai_auto",
    is_ai_generated: true,
    sent_at: new Date().toISOString(),
  })

  return { success: true, response: aiResponse }
}

// Smart reply generation with context
async function generateSmartReply(context: any): Promise<string> {
  // This is a placeholder - in production, integrate with AI SDK
  const { contactName, lastMessage, tone } = context

  // Simple template-based responses for now
  const templates = {
    greeting: `Hi ${contactName}! Thanks for reaching out. I'd be happy to help you with your real estate needs. What are you looking for?`,
    inquiry: `Thanks for your question! Let me get back to you with detailed information shortly. In the meantime, is there anything specific I can help you with?`,
    showing: `I'd love to show you this property! What times work best for you this week? I can also send you more details about the home.`,
    professional: `Thank you for contacting me, ${contactName}. I'll review your inquiry and get back to you within the hour with a comprehensive response.`,
  }

  // Simple keyword matching (replace with actual AI)
  if (lastMessage.toLowerCase().includes("show") || lastMessage.toLowerCase().includes("tour")) {
    return templates.showing
  } else if (lastMessage.toLowerCase().includes("price") || lastMessage.toLowerCase().includes("worth")) {
    return templates.inquiry
  } else if (lastMessage.toLowerCase().includes("hi") || lastMessage.toLowerCase().includes("hello")) {
    return templates.greeting
  }

  return templates.professional
}

// Track behavioral event for lead scoring
export async function trackBehavioralEvent(params: {
  contactId: string
  eventType: string
  eventData?: any
  pointsAwarded?: number
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: "Not authenticated" }
  }

  const { error } = await supabase.from("behavioral_events").insert({
    contact_id: params.contactId,
    event_type: params.eventType,
    event_data: params.eventData || {},
    points_awarded: params.pointsAwarded || 0,
    tracked_at: new Date().toISOString(),
  })

  if (error) {
    console.error("Error tracking behavioral event:", error)
    return { success: false, error: error.message }
  }

  // Recalculate lead score
  await calculateLeadScore(params.contactId)

  return { success: true }
}

// Calculate and update lead score
export async function calculateLeadScore(contactId: string) {
  const supabase = await createClient()

  // Get all behavioral events for this contact
  const { data: events } = await supabase
    .from("behavioral_events")
    .select("*")
    .eq("contact_id", contactId)
    .order("tracked_at", { ascending: false })

  // Get contact info
  const { data: contact } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .single()

  if (!contact || !events) {
    return { success: false, error: "Contact or events not found" }
  }

  // Calculate score based on events
  let score = 0
  let engagement = 0
  let recency = 0
  let intent = 0

  // Points for different behaviors
  const eventPoints: Record<string, number> = {
    website_visit: 5,
    email_open: 3,
    email_click: 10,
    form_submit: 15,
    property_view: 8,
    property_save: 12,
    showing_request: 25,
    call_answered: 20,
    sms_reply: 10,
    cma_request: 30,
    document_download: 15,
  }

  // Calculate engagement score (last 30 days)
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  events.forEach((event) => {
    const eventDate = new Date(event.tracked_at)
    const points = eventPoints[event.event_type] || event.points_awarded || 0

    score += points

    if (eventDate > thirtyDaysAgo) {
      engagement += points
    }

    // Recency score (more recent = higher score)
    const daysSinceEvent = Math.floor(
      (Date.now() - eventDate.getTime()) / (1000 * 60 * 60 * 24)
    )
    if (daysSinceEvent < 7) {
      recency += points * 2 // Double points for activity in last 7 days
    } else if (daysSinceEvent < 30) {
      recency += points
    }
  })

  // Intent score based on high-value actions
  const highIntentEvents = events.filter(
    (e) =>
      e.event_type === "showing_request" ||
      e.event_type === "cma_request" ||
      e.event_type === "document_download"
  )
  intent = highIntentEvents.length * 20

  // Normalize scores
  const totalScore = Math.min(100, Math.floor(score / 10))
  const engagementScore = Math.min(100, engagement)
  const recencyScore = Math.min(100, recency)
  const intentScore = Math.min(100, intent)

  // Determine priority tier
  let priority: "hot" | "warm" | "cold" = "cold"
  if (totalScore >= 70 || intentScore >= 60) {
    priority = "hot"
  } else if (totalScore >= 40 || engagementScore >= 50) {
    priority = "warm"
  }

  // Update or insert lead score
  const { error } = await supabase.from("lead_scores").upsert({
    contact_id: contactId,
    total_score: totalScore,
    engagement_score: engagementScore,
    recency_score: recencyScore,
    intent_score: intentScore,
    priority_tier: priority,
    last_calculated_at: new Date().toISOString(),
  })

  if (error) {
    console.error("Error updating lead score:", error)
    return { success: false, error: error.message }
  }

  return {
    success: true,
    score: {
      total: totalScore,
      engagement: engagementScore,
      recency: recencyScore,
      intent: intentScore,
      priority,
    },
  }
}

// Get lead score for a contact
export async function getLeadScore(contactId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("lead_scores")
    .select("*")
    .eq("contact_id", contactId)
    .single()

  if (error && error.code !== "PGRST116") {
    console.error("Error fetching lead score:", error)
    return { success: false, error: error.message, score: null }
  }

  if (!data) {
    // Calculate score if it doesn't exist
    const result = await calculateLeadScore(contactId)
    if (result.success) {
      return { success: true, score: result.score }
    }
  }

  return { success: true, score: data }
}

// Get hot leads (priority scoring)
export async function getHotLeads(limit = 50) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("lead_scores")
    .select(
      `
      *,
      contacts (
        id,
        first_name,
        last_name,
        email,
        phone,
        contact_type,
        source,
        created_at
      )
    `
    )
    .eq("contacts.agent_id", agentId)
    .eq("contacts.brokerage_id", brokerageId)
    .eq("priority_tier", "hot")
    .order("total_score", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("Error fetching hot leads:", error)
    return { success: false, error: error.message, leads: [] }
  }

  return { success: true, leads: data || [] }
}
