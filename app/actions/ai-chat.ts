"use server"

import { createClient } from "@/lib/supabase/server"
import { requirePermission } from "@/lib/security"
import { revalidatePath } from "next/cache"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"

// =====================================================
// CHAT SESSION MANAGEMENT
// =====================================================

export async function createChatSession(data: {
  agentId: string
  leadId?: string
  sessionType: "lead_qualification" | "client_support" | "transaction_help" | "market_insights"
}) {
  console.log("[v0] createChatSession called with agentId:", data.agentId)
  
  // Validate UUID format
  if (!isValidUUID(data.agentId)) {
    console.log("[v0] Invalid UUID format for agentId, cannot create session")
    throw new Error("Invalid agent ID format")
  }

  const supabase = await createClient()

  // Check permission if lead is involved
  if (data.leadId && isValidUUID(data.leadId)) {
    await requirePermission("view", "contact", data.leadId)
  }

  // Get lead context if provided
  let contextData: any = {}
  if (data.leadId && isValidUUID(data.leadId)) {
    const { data: lead } = await supabase
      .from("contacts")
      .select(`
        *,
        lead_intelligence (*),
        lead_behavioral_data (*)
      `)
      .eq("id", data.leadId)
      .single()

    contextData = {
      lead: lead,
      temperature: lead?.lead_temperature,
      lastContact: lead?.last_contact_date,
      interests: lead?.lead_intelligence?.[0]?.identified_interests,
    }
  }

  const { data: session, error } = await supabase
    .from("conversations")
    .insert({
      agent_id: data.agentId,
      lead_id: data.leadId && isValidUUID(data.leadId) ? data.leadId : null,
      session_type: data.sessionType,
      context_data: contextData,
    })
    .select()
    .single()

  if (error) {
    console.error("[v0] Chat session creation failed:", error)
    throw error
  }

  console.log("[v0] Chat session created successfully:", session.id)

  // Create welcome message
  await supabase.from("messages").insert({
    session_id: session.id,
    sender_type: "ai_assistant",
    message_content: data.leadId
      ? `I'm ready to help you engage with this lead using them-first communication. I have their profile loaded and can suggest personalized approaches.`
      : `I'm here to assist you. What would you like help with today?`,
    message_type: "system",
  })

  revalidatePath("/dashboard/chat")
  return session
}

export async function sendChatMessage(data: {
  sessionId: string
  senderId: string
  messageContent: string
  requestAiResponse?: boolean
}) {
  const supabase = await createClient()

  let temperatureAnalysis = null
  const isClientMessage = data.senderId !== "agent" // Adjust this logic based on your sender identification

  if (isClientMessage) {
    temperatureAnalysis = await analyzeLeadTemperatureFromMessage(data.messageContent, data.sessionId)

    // Update session with new temperature
    await supabase
      .from("conversations")
      .update({
        lead_temperature: temperatureAnalysis.temperature,
        temperature_analysis: {
          score: temperatureAnalysis.score,
          sentiment: temperatureAnalysis.sentiment,
          indicators: temperatureAnalysis.indicators,
          analyzed_at: new Date().toISOString(),
        },
      })
      .eq("id", data.sessionId)
  }

  // Analyze them-first quality
  const themFirstAnalysis = await analyzeThemFirstLanguage(data.messageContent)

  // Check compliance
  const complianceCheck = await checkMessageCompliance(data.messageContent, data.sessionId)

  const { data: message, error } = await supabase
    .from("messages")
    .insert({
      session_id: data.sessionId,
      sender_type: isClientMessage ? "client" : "agent",
      sender_id: data.senderId,
      message_content: data.messageContent,
      them_first_analysis: themFirstAnalysis,
      compliance_flagged: !complianceCheck.passed,
      compliance_issues: complianceCheck.issues,
      metadata: temperatureAnalysis
        ? {
            temperature: temperatureAnalysis.temperature,
            sentiment_score: temperatureAnalysis.score,
            sentiment: temperatureAnalysis.sentiment,
          }
        : null,
    })
    .select()
    .single()

  if (error) throw error

  // Update session activity
  await supabase
    .from("conversations")
    .update({
      last_activity_at: new Date().toISOString(),
      them_first_score: themFirstAnalysis.score,
    })
    .eq("id", data.sessionId)

  // Generate AI response if requested
  if (data.requestAiResponse) {
    const aiResponse = await generateAiResponse(data.sessionId, data.messageContent)

    await supabase.from("messages").insert({
      session_id: data.sessionId,
      sender_type: "ai_assistant",
      message_content: aiResponse.message,
      message_type: aiResponse.type,
      metadata: aiResponse.metadata,
    })

    // Generate suggestions
    if (aiResponse.suggestions) {
      const suggestions = aiResponse.suggestions.map((sug: any) => ({
        session_id: data.sessionId,
        suggestion_type: sug.type,
        suggestion_content: sug.content,
        confidence_score: sug.confidence,
      }))

      await supabase.from("ai_suggestions").insert(suggestions)
    }
  }

  revalidatePath("/dashboard/chat")
  return message
}

// =====================================================
// THEM-FIRST ANALYSIS
// =====================================================

async function analyzeThemFirstLanguage(message: string): Promise<any> {
  // Them-first indicators
  const themFirstTerms = [
    "you deserve",
    "your goals",
    "your needs",
    "your family",
    "your timeline",
    "for you",
    "your situation",
    "your home",
    "your dreams",
    "your future",
    "what matters to you",
    "your priorities",
    "your concerns",
  ]

  // Agent-first indicators (to avoid)
  const agentFirstTerms = [
    "I can",
    "I will",
    "my service",
    "my expertise",
    "hire me",
    "work with me",
    "I have",
    "my experience",
    "my team",
    "my success",
    "I specialize",
  ]

  const messageLower = message.toLowerCase()

  const themFirstCount = themFirstTerms.filter((term) => messageLower.includes(term)).length

  const agentFirstCount = agentFirstTerms.filter((term) => messageLower.includes(term)).length

  // Calculate score (0-100)
  const score = Math.min(100, Math.max(0, 50 + themFirstCount * 10 - agentFirstCount * 15))

  return {
    score,
    themFirstCount,
    agentFirstCount,
    feedback:
      score < 50
        ? "Consider focusing more on the client's needs rather than your services"
        : score > 70
          ? "Excellent them-first approach!"
          : "Good balance, but could emphasize client benefits more",
  }
}

// =====================================================
// COMPLIANCE CHECKING
// =====================================================

async function checkMessageCompliance(message: string, sessionId: string): Promise<any> {
  const supabase = await createClient()

  // Get session context to check lead temperature
  const { data: session } = await supabase.from("conversations").select("*, contacts(*)").eq("id", sessionId).single()

  const issues: any[] = []

  // Check prohibited phrases
  const { data: prohibitedPhrases } = await supabase.from("prohibited_phrases").select("*").eq("is_active", true)

  prohibitedPhrases?.forEach((phrase) => {
    const regex = new RegExp(phrase.phrase_pattern || phrase.phrase, "gi")
    if (regex.test(message)) {
      issues.push({
        type: "prohibited_phrase",
        phrase: phrase.phrase,
        category: phrase.category,
        severity: phrase.severity,
        alternative: phrase.suggested_alternative,
      })
    }
  })

  // Check for cold lead channel restrictions
  if (session?.contacts?.lead_temperature === "cold") {
    const coldLeadChannels = ["email", "print_mail"]
    const mentionsSMSOrCall = /\b(call|phone|text|sms|message)\b/gi.test(message)

    if (mentionsSMSOrCall) {
      issues.push({
        type: "cold_lead_channel_violation",
        phrase: "Contact method mentioned",
        severity: "blocking",
        alternative: "Cold leads can only be contacted via email or print mail per compliance",
      })
    }
  }

  return {
    passed: issues.filter((i) => i.severity === "blocking").length === 0,
    issues,
  }
}

// =====================================================
// AI RESPONSE GENERATION
// =====================================================

async function generateAiResponse(sessionId: string, userMessage: string): Promise<any> {
  const supabase = await createClient()

  // Get session context
  const { data: session } = await supabase
    .from("conversations")
    .select(`
      *,
      contacts (*,
        lead_intelligence (*),
        lead_behavioral_data (*)
      )
    `)
    .eq("id", sessionId)
    .single()

  // Get conversation history
  const { data: messages } = await supabase
    .from("messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(20)

  // Build context for AI
  const leadContext = session?.contacts
    ? `
Lead Information:
- Name: ${session.contacts.first_name} ${session.contacts.last_name}
- Temperature: ${session.contacts.lead_temperature}
- Interests: ${session.contacts.lead_intelligence?.[0]?.identified_interests?.join(", ") || "Not identified"}
- Last Contact: ${session.contacts.last_contact_date || "Never"}
- Source: ${session.contacts.lead_source}
`
    : "No lead selected"

  const conversationHistory = messages?.map((m) => `${m.sender_type}: ${m.message_content}`).join("\n") || ""

  // Create AI prompt with them-first philosophy
  const prompt = `You are an AI assistant helping a real estate agent communicate with leads and clients using a "them-first" communication philosophy.

CRITICAL RULES:
1. ALWAYS focus on the CLIENT'S needs, goals, and situation - never on the agent's services or credentials
2. Use "you" and "your" language, minimize "I" and "my" language
3. If the lead is COLD, remind the agent they can ONLY use email or print mail (no SMS, calls, or social media)
4. Suggest responses that emphasize what the client deserves, their timeline, their priorities
5. Avoid phrases like "I can help" or "my expertise" - instead say "you deserve expert guidance"
6. Check for Fair Housing violations - never suggest discriminatory language
7. Keep responses concise, actionable, and compliant

${leadContext}

Conversation History:
${conversationHistory}

Agent's Latest Message: ${userMessage}

Provide:
1. A them-first response suggestion (if the agent is drafting communication)
2. Specific insights about the lead (if applicable)
3. Next best actions
4. Any compliance warnings

Format as JSON:
{
  "message": "Your AI response here",
  "type": "suggestion|insight|warning",
  "metadata": {
    "leadInsights": ["insight1", "insight2"],
    "complianceNotes": ["note1"],
    "recommendedChannel": "email|print|phone"
  },
  "suggestions": [
    {
      "type": "response_template",
      "content": {"template": "suggested response"},
      "confidence": 0.85
    }
  ]
}
`

  try {
    const result = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: prompt,
    })

    // Parse JSON response
    const aiResponse = JSON.parse(result.text)
    return aiResponse
  } catch (error) {
    console.error("[v0] AI generation error:", error)
    return {
      message: "I'm having trouble generating a response right now. Please try again.",
      type: "error",
      metadata: {},
      suggestions: [],
    }
  }
}

// =====================================================
// LEAD TEMPERATURE ANALYSIS FROM MESSAGE CONTENT
// =====================================================

async function analyzeLeadTemperatureFromMessage(
  message: string,
  sessionId: string,
): Promise<{
  temperature: "hot" | "warm" | "cold"
  score: number
  sentiment: string
  indicators: string[]
}> {
  const messageLower = message.toLowerCase().trim()

  // Hot indicators - positive, engaged, ready to act
  const hotIndicators = [
    { pattern: /\b(excited|interested|ready|love|perfect|great|amazing|wonderful)\b/gi, weight: 15 },
    { pattern: /\b(yes|absolutely|definitely|for sure|sounds good)\b/gi, weight: 12 },
    { pattern: /\b(when can|let's schedule|what's next|ready to)\b/gi, weight: 20 },
    { pattern: /\b(tell me more|learn more|want to know)\b/gi, weight: 10 },
    { pattern: /[?].*\b(available|schedule|meeting|call|appointment)\b/gi, weight: 15 },
  ]

  // Warm indicators - considering, asking questions, engaged but not ready
  const warmIndicators = [
    { pattern: /\b(maybe|possibly|considering|thinking about|looking into)\b/gi, weight: 10 },
    { pattern: /\b(what if|how does|can you explain|tell me about)\b/gi, weight: 8 },
    { pattern: /\b(timeline|budget|options|alternatives)\b/gi, weight: 7 },
    { pattern: /[?]/g, weight: 5 }, // Questions show engagement
  ]

  // Cold indicators - negative, disengaged, dismissive
  const coldIndicators = [
    { pattern: /\b(not interested|no thanks|remove|unsubscribe|stop|delete)\b/gi, weight: -25 },
    { pattern: /\b(busy|later|another time|not now|not ready)\b/gi, weight: -15 },
    { pattern: /\b(too expensive|can't afford|no money|broke)\b/gi, weight: -12 },
    { pattern: /\b(maybe later|call back|not sure|don't know)\b/gi, weight: -10 },
    { pattern: /^(ok|k|fine|whatever|idk)$/gi, weight: -20 }, // Short dismissive
  ]

  let score = 50 // Start neutral
  const foundIndicators: string[] = []

  // Check hot indicators
  hotIndicators.forEach(({ pattern, weight }) => {
    const matches = message.match(pattern)
    if (matches) {
      score += weight * matches.length
      foundIndicators.push(`Positive: ${matches.join(", ")}`)
    }
  })

  // Check warm indicators
  warmIndicators.forEach(({ pattern, weight }) => {
    const matches = message.match(pattern)
    if (matches) {
      score += weight * matches.length
      foundIndicators.push(`Engaged: ${matches.join(", ")}`)
    }
  })

  // Check cold indicators
  coldIndicators.forEach(({ pattern, weight }) => {
    const matches = message.match(pattern)
    if (matches) {
      score += weight * matches.length
      foundIndicators.push(`Negative: ${matches.join(", ")}`)
    }
  })

  // Message length analysis
  if (messageLower.length < 10) {
    score -= 10 // Very short = less engaged
    foundIndicators.push("Short response (low engagement)")
  } else if (messageLower.length > 100) {
    score += 5 // Longer = more engaged
    foundIndicators.push("Detailed response (high engagement)")
  }

  // Determine temperature based on score
  let temperature: "hot" | "warm" | "cold"
  let sentiment: string

  if (score >= 70) {
    temperature = "hot"
    sentiment = "Highly engaged and positive - ready to move forward"
  } else if (score >= 40) {
    temperature = "warm"
    sentiment = "Moderately engaged - needs nurturing"
  } else {
    temperature = "cold"
    sentiment = "Low engagement or negative - use email/print only per compliance"
  }

  return {
    temperature,
    score: Math.min(100, Math.max(0, score)),
    sentiment,
    indicators: foundIndicators,
  }
}

export async function analyzeClientMessageTemperature(message: string, sessionId: string) {
  return analyzeLeadTemperatureFromMessage(message, sessionId)
}

// =====================================================
// HELPER FUNCTIONS
// =====================================================

export async function getAiSuggestions(sessionId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("ai_suggestions")
    .select("*")
    .eq("session_id", sessionId)
    .eq("was_accepted", false)
    .order("created_at", { ascending: false })
    .limit(5)

  if (error) throw error
  return data
}

export async function acceptAiSuggestion(suggestionId: string) {
  const supabase = await createClient()

  const { error } = await supabase
    .from("ai_suggestions")
    .update({
      was_accepted: true,
      accepted_at: new Date().toISOString(),
    })
    .eq("id", suggestionId)

  if (error) throw error

  revalidatePath("/dashboard/chat")
  return { success: true }
}

export async function getChatSession(sessionId: string) {
  const supabase = await createClient()

  const { data: session, error } = await supabase
    .from("conversations")
    .select(`
      *,
      contacts (*,
        lead_intelligence (*),
        lead_behavioral_data (*)
      ),
      messages (*),
      ai_suggestions (*)
    `)
    .eq("id", sessionId)
    .single()

  if (error) throw error
  return session
}

export async function getAgentChatSessions(agentId: string) {
  const supabase = await createClient()

  if (!isValidUUID(agentId)) {
    console.log("[v0] Invalid UUID format for agent_id, returning empty sessions")
    return [] // Return empty array instead of object
  }

  const { data, error } = await supabase
    .from("conversations")
    .select(
      `
      *,
      contacts (
        first_name,
        last_name,
        engagement_score,
        intent_score,
        source
      ),
      messages (id)
    `,
    )
    .eq("agent_id", agentId)
    .eq("session_status", "active")
    .order("last_activity_at", { ascending: false })

  if (error) {
    console.error("[v0] Error fetching chat sessions:", error)
    return [] // Return empty array on error instead of throwing
  }

  return data || []
}

export async function endChatSession(sessionId: string) {
  const supabase = await createClient()

  const { error } = await supabase
    .from("conversations")
    .update({
      session_status: "completed",
      ended_at: new Date().toISOString(),
    })
    .eq("id", sessionId)

  if (error) throw error

  revalidatePath("/dashboard/chat")
  return { success: true }
}

export async function searchConversationHistory(leadId: string, searchTerm?: string) {
  const supabase = await createClient()

  let query = supabase
    .from("lead_conversation_history")
    .select("*")
    .eq("lead_id", leadId)
    .order("occurred_at", { ascending: false })

  if (searchTerm) {
    query = query.ilike("message_content", `%${searchTerm}%`)
  }

  const { data, error } = await query.limit(50)

  if (error) throw error
  return data
}

// =====================================================
// CHAT TEMPLATES
// =====================================================

export async function getChatTemplates(filters?: {
  category?: string
  leadType?: string
  complianceApproved?: boolean
}) {
  const supabase = await createClient()

  let query = supabase.from("chat_templates").select("*").order("usage_count", { ascending: false })

  if (filters?.category) {
    query = query.eq("template_category", filters.category)
  }

  if (filters?.leadType) {
    query = query.contains("allowed_lead_types", [filters.leadType])
  }

  if (filters?.complianceApproved !== undefined) {
    query = query.eq("compliance_approved", filters.complianceApproved)
  }

  const { data, error } = await query

  if (error) throw error
  return data
}

export async function useChatTemplate(templateId: string, sessionId: string) {
  const supabase = await createClient()

  // Get template
  const { data: template } = await supabase.from("chat_templates").select("*").eq("id", templateId).single()

  if (!template) throw new Error("Template not found")

  // Increment usage count
  await supabase
    .from("chat_templates")
    .update({ usage_count: (template.usage_count || 0) + 1 })
    .eq("id", templateId)

  // Get session context for personalization
  const { data: session } = await supabase.from("conversations").select("*, contacts(*)").eq("id", sessionId).single()

  // Personalize template
  let personalizedContent = template.template_content
  if (session?.contacts) {
    personalizedContent = personalizedContent
      .replace("{first_name}", session.contacts.first_name || "")
      .replace("{last_name}", session.contacts.last_name || "")
      .replace("{city}", session.contacts.city || "")
  }

  return {
    template,
    personalizedContent,
  }
}

// =====================================================
// AGENT PREFERENCES
// =====================================================

export async function updateAgentChatPreferences(agentId: string, preferences: any) {
  const supabase = await createClient()

  const { error } = await supabase.from("agent_chat_preferences").upsert({
    agent_id: agentId,
    ...preferences,
    updated_at: new Date().toISOString(),
  })

  if (error) throw error

  revalidatePath("/dashboard/settings")
  return { success: true }
}

export async function getAgentChatPreferences(agentId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase.from("agent_chat_preferences").select("*").eq("agent_id", agentId).single()

  if (error && error.code !== "PGRST116") throw error

  // Return default preferences if none exist
  return (
    data || {
      auto_suggest_responses: true,
      them_first_coaching: true,
      compliance_alerts: true,
      lead_insights_enabled: true,
      preferred_tone: "professional",
      custom_prompts: {},
    }
  )
}

// =====================================================
// MESSAGE ACCESS CONTROL
// =====================================================

export async function grantMessageAccess(data: {
  conversationId: string
  userId: string
  userType: "agent" | "client" | "admin" | "broker"
  canRead?: boolean
  canWrite?: boolean
  grantedBy: string
  expiresAt?: string
}) {
  const supabase = await createClient()

  const { error } = await supabase.from("message_access_control").upsert({
    conversation_id: data.conversationId,
    user_id: data.userId,
    user_type: data.userType,
    can_read: data.canRead ?? true,
    can_write: data.canWrite ?? true,
    granted_by: data.grantedBy,
    expires_at: data.expiresAt,
    granted_at: new Date().toISOString(),
  })

  if (error) throw error

  revalidatePath("/dashboard/chat")
  return { success: true }
}

export async function revokeMessageAccess(conversationId: string, userId: string) {
  const supabase = await createClient()

  const { error } = await supabase
    .from("message_access_control")
    .delete()
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)

  if (error) throw error

  revalidatePath("/dashboard/chat")
  return { success: true }
}

export async function getMessageAccessList(conversationId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("message_access_control")
    .select(`
      *,
      users (first_name, last_name, email)
    `)
    .eq("conversation_id", conversationId)

  if (error) throw error
  return data
}

// =====================================================
// ADDITIONAL EXPORTS
// =====================================================

export async function getChatSessions(userId: string) {
  return getAgentChatSessions(userId)
}

export async function checkThemFirstCompliance(message: string) {
  return analyzeThemFirstLanguage(message)
}

export type ChatSession = {
  id: string
  agent_id: string
  lead_id?: string
  session_type: string
  session_status: string
  them_first_score: number
  last_activity_at: string
  context_data?: any
  contacts?: any
  messages?: any[]
  ai_suggestions?: any[]
}
