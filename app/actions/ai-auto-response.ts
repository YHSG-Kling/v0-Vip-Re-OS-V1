"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { resolveModel } from "@/lib/ai/resolve-model"

// Get auto-response settings for the current agent
export async function getAutoResponseSettings() {
  const supabase = await createClient()
  const { agentId } = await getAgentContext()

  if (!agentId) {
    return { success: false, error: "Not authenticated", settings: null }
  }

  const { data, error } = await supabase
    .from("auto_response_settings")
    .select("*")
    .eq("agent_id", agentId)
    .single()

  if (error && error.code !== "PGRST116") {
    console.error("Error fetching auto-response settings:", error)
    return { success: false, error: error.message, settings: null }
  }

  // Return default settings if none exist (live schema columns only).
  if (!data) {
    return {
      success: true,
      settings: {
        is_enabled: false,
        tone: "professional",
        delay_minutes: 5,
        keywords: [],
        custom_prompt: null,
      },
    }
  }

  return { success: true, settings: data }
}

// Update auto-response settings
export async function updateAutoResponseSettings(settings: {
  is_enabled?: boolean
  tone?: string
  delay_minutes?: number
  keywords?: string[]
  custom_prompt?: string | null
}) {
  const supabase = await createClient()
  const { agentId, brokerageId } = await getAgentContext()

  if (!agentId) {
    return { success: false, error: "Not authenticated" }
  }

  // auto_response_settings is keyed by agent_id (NOT NULL, UNIQUE, FK→agents).
  const { error } = await supabase
    .from("auto_response_settings")
    .upsert(
      {
        agent_id: agentId,
        brokerage_id: brokerageId,
        ...settings,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id" },
    )

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

  // Generate AI response — real call: generateSmartReply rides generateTextRouted
  // (routed model + fair-use quota + usage log), compliance-constrained prompt.
  const aiResponse = await generateSmartReply(context)

  // Log the AI response
  const { agentId } = await getAgentContext()
  // messages live cols: conversation_id, contact_id, agent_id, type, direction,
  // subject, body, status, compliance_checked. No content/channel/is_ai_generated/
  // sent_at/compliance_approved fields. ai_auto provenance lives in `type`.
  await supabase.from("messages").insert({
    conversation_id: params.conversationId,
    contact_id: params.contactId,
    agent_id: agentId,
    type: "ai_auto_response",
    direction: "outbound",
    body: aiResponse,
    status: "queued",
    compliance_checked: false,
  })

  return { success: true, response: aiResponse }
}

// Smart reply generation using AI
async function generateSmartReply(context: {
  contactName: string
  contactType: string
  lastMessage: string
  conversationHistory: any[]
  tone: string
  agentName: string
}): Promise<string> {
  const recentHistory = context.conversationHistory
    .slice(0, 5)
    .reverse()
    .map((m: any) =>
      `${m.direction === "inbound" ? context.contactName : context.agentName}: ${m.content ?? m.body ?? ""}`
    )
    .join("\n")

  const { text } = await generateText({
    model: resolveModel("openai/gpt-4o-mini"),
    prompt: `You are ${context.agentName}, a professional real estate agent. Write a ${context.tone} reply.

Contact: ${context.contactName} (${context.contactType || "prospect"})
${recentHistory ? `Recent conversation:\n${recentHistory}\n` : ""}Their latest message: "${context.lastMessage}"

Rules:
- 1–3 sentences, no bullet lists
- Do not use "guaranteed", "can't lose", or "risk-free"
- Match the ${context.tone} tone
- End with a clear next step or open question when natural
- No signature line

Reply:`,
  })

  return text.trim()
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

  // behavioral_patterns is a brokerage pattern-definition CATALOG, not an event log.
  // Per-entity events belong in lead_behavioral_data (keyed by lead_id, event_type NOT NULL).
  const { brokerageId } = await getAgentContext()
  const { error } = await supabase.from("lead_behavioral_data").insert({
    lead_id: params.contactId,
    event_type: params.eventType,
    event_data: {
      ...(params.eventData || {}),
      points_awarded: params.pointsAwarded || 0,
    },
    brokerage_id: brokerageId,
    occurred_at: new Date().toISOString(),
  })

  if (error) {
    console.error("Error tracking behavioral event:", error)
    return { success: false, error: error.message }
  }

  // Recalculate lead score
  await calculateLeadScore(params.contactId)

  return { success: true }
}

/**
 * LEGACY local scorer (auto-response context).
 *
 * @deprecated New callers should use `calculateLeadScore` from
 * `lib/services/lead-management.service.ts` (the orchestrator wrapping the
 * canonical Layer 1 multi-factor scorer). This local function predates the
 * canonical layering and remains only for the auto-response flow until that
 * caller is migrated. Do NOT add new callers.
 *
 * See `lib/lead-scoring/LAYERING.md` for full layering rules.
 */
export async function calculateLeadScore(contactId: string) {
  const supabase = await createClient()

  // Get all behavioral events for this contact (lead_behavioral_data event log)
  const { data: events } = await supabase
    .from("lead_behavioral_data")
    .select("*")
    .eq("lead_id", contactId)
    .order("occurred_at", { ascending: false })

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
    const eventDate = new Date(event.occurred_at)
    const points = eventPoints[event.event_type] || event.event_data?.points_awarded || 0

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

  // Update or insert lead score - using actual schema columns
  // Schema: id, contact_id, agent_id, score, score_factors, ai_confidence, computed_at
  const { agentId } = await getAgentContext()
  const { error } = await supabase.from("lead_scores").upsert({
    contact_id: contactId,
    agent_id: agentId,
    score: totalScore,
    score_factors: {
      engagement: engagementScore,
      recency: recencyScore,
      intent: intentScore,
      priority,
    },
    ai_confidence: 0.8,
    computed_at: new Date().toISOString(),
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

// Get hot leads (priority scoring) - using actual schema columns
// Schema: id, contact_id, agent_id, score, score_factors, ai_confidence, computed_at
export async function getHotLeads(limit = 50) {
  const context = await getAgentContext()
  if (!context?.agentId) {
    return { success: false, error: "Agent context not available", leads: [] }
  }
  
  const { agentId, brokerageId } = context
  const supabase = await createClient()

  // Try lead_scores first, fallback to contacts with high intent_score
  const { data, error } = await supabase
    .from("lead_scores")
    .select("id, contact_id, agent_id, score, score_factors, ai_confidence, computed_at")
    .eq("agent_id", agentId)
    .gte("score", 70)
    .order("score", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("Error fetching hot leads:", error)
    // Fallback: query contacts directly with high intent_score
    const { data: contactsData, error: contactsError } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, email, phone, contact_type, source, intent_score, engagement_score, created_at")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .or("intent_score.gte.70,engagement_score.gte.70,status.eq.hot")
      .order("intent_score", { ascending: false, nullsFirst: false })
      .limit(limit)

    if (contactsError) {
      console.error("Error fetching contacts fallback:", contactsError)
      return { success: false, error: contactsError.message, leads: [] }
    }

    // Map contacts to the expected hot leads format
    return {
      success: true,
      leads: (contactsData || []).map(c => ({
        id: c.id,
        contact_id: c.id,
        agent_id: agentId,
        score: c.intent_score || c.engagement_score || 70,
        score_factors: { engagement: c.engagement_score, intent: c.intent_score },
        ai_confidence: 0.8,
        computed_at: new Date().toISOString(),
        contacts: c,
      })),
    }
  }

  // Fetch contacts separately to avoid relationship issues
  const leads = data || []
  if (leads.length > 0) {
    const contactIds = leads.map(l => l.contact_id).filter(Boolean)
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, email, phone, contact_type, source, created_at")
        .in("id", contactIds)
        .eq("brokerage_id", brokerageId)

      const contactMap = new Map(contacts?.map(c => [c.id, c]) || [])
      return {
        success: true,
        leads: leads.map(l => ({
          ...l,
          contacts: contactMap.get(l.contact_id) || null,
        })),
      }
    }
  }

  return { success: true, leads: [] }
}
