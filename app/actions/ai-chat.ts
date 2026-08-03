"use server"

/**
 * AI CHAT — conversations + messages (the inbox model).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OLD SCHEMA-DRIFT WARNING THAT USED TO HEAD THIS FILE WAS STALE, AND IT
 * WAS THE DANGEROUS KIND OF STALE. It claimed this file wrote model #2's column
 * names into model #1's tables, that "every write fails silently at runtime",
 * and that the file "has no functional callers" — an invitation to delete it.
 *
 * Re-verified against the live database: public.messages carries sender_type,
 * sender_id, body, them_first_analysis, compliance_flagged, compliance_issues,
 * metadata and type. Every column this file writes EXISTS. A later migration
 * closed the drift and nobody updated the warning.
 *
 * ONE REAL DEFECT SURVIVED, and it was not the one the warning described:
 * messages.compliance_issues is character varying[] (udt _varchar), while
 * checkMessageCompliance returns an array of OBJECTS. Writing the objects
 * straight in fails with 42804 — verified live. The structured detail now goes
 * to metadata (jsonb, where it belongs) and the column gets the human-readable
 * labels it is typed for.
 *
 * The two conversation models are still real and still distinct:
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The platform has two distinct conversation models:
 *
 *   1. messages + conversations  — email/SMS inbox conversations with
 *      external contacts (see app/actions/ai-communication-hub.ts).
 *      conversations cols: id, contact_id, agent_id, type, status,
 *      message_count, last_message_at, unread_count, sentiment,
 *      urgency_score, brokerage_id, intent_primary, ...
 *      messages cols: id, conversation_id, contact_id, agent_id, type,
 *      direction, subject, body, status, attachment_urls, ...
 *
 *   2. chat_sessions + chat_messages — in-app AI agent chat sessions.
 *      chat_sessions cols: id, lead_id, contact_id, session_type,
 *      metadata, brokerage_id, agent_id, source,
 *      widget_session_token, visitor_fingerprint, capture_state, status
 *      chat_messages cols: id, session_id, role, content, metadata,
 *      created_at
 *
 * This file deliberately targets model #1 — an agent talking WITH a contact,
 * which is an inbox conversation. Model #2 (chat_sessions/chat_messages) is the
 * widget/visitor rail and is not what these functions are for. Both are real;
 * neither replaces the other.
 *
 * Every table read here was verified to exist: ai_suggestions, chat_templates,
 * agent_chat_preferences, message_access_control, prohibited_phrases.
 *
 * TABLE FACTS THAT BIT, all confirmed against the live database:
 *   · agent_chat_preferences has UNIQUE (agent_id). An upsert with no conflict
 *     target defaults to the primary key, a fresh uuid is generated, and the
 *     SECOND save raises 23505 — an agent could set preferences exactly once.
 *   · message_access_control has UNIQUE (conversation_id, user_id) and the same
 *     upsert bug, plus NO foreign key to users — so a PostgREST `users(...)`
 *     embed cannot resolve and the read throws.
 *   · messages.compliance_issues is character varying[], not jsonb.
 */

import { createClient } from "@/lib/supabase/server"
import { requirePermission } from "@/lib/security"
import { revalidatePath } from "next/cache"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { getAgentContext } from "@/lib/identity"
import {
  resolveReplyStyle,
  isReplyModel,
  isReplyTone,
  DEFAULT_REPLY_MODEL,
  DEFAULT_REPLY_TONE,
  type ReplyModel,
  type ReplyTone,
} from "@/lib/ai/reply-style"

/**
 * Flatten structured compliance issues to the varchar[] the column holds.
 * PURE — the structured form is kept alongside in metadata, so nothing is lost.
 */
function complianceIssueLabels(issues: unknown): string[] {
  if (!Array.isArray(issues)) return []
  return issues.map((i: any) =>
    typeof i === "string"
      ? i
      : [i?.type, i?.phrase].filter(Boolean).join(": ") || JSON.stringify(i),
  )
}

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
    // The same unresolvable embed getChatSession carried: lead_intelligence and
    // lead_behavioral_data are keyed on lead_id and have NO foreign key to
    // contacts, so PostgREST refused the whole request (PGRST200) and `lead`
    // came back null — which the `?.` chain below then read as "no context",
    // silently. Every session created here started with an EMPTY context_data
    // even when the contact was rich. Fixing one sibling and not the other is
    // how a defect class survives being found, so both are corrected together.
    const { data: lead, error: leadError } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", data.leadId)
      .maybeSingle()

    if (leadError) {
      console.error("[v0] Chat session contact load failed:", leadError)
    }

    contextData = {
      lead: lead,
      temperature: lead?.lead_temperature,
      lastContact: lead?.last_contact_date,
      // `interests` used to come from the embed that could never resolve.
      // contacts has no route to lead_intelligence — there is no contact->lead
      // column at all — so this is omitted rather than reported as empty.
    }
  }

  const { data: session, error } = await supabase
    .from("conversations")
    .insert({
      agent_id: data.agentId,
      // NOT a lead id despite the name: the field is validated above via
      // requirePermission("view","contact", …) and resolved with
      // .from("contacts").eq("id", …). conversations.contact_id FKs contacts(id),
      // so this is CORRECT. Left named leadId because it is a public server-action
      // parameter; documented here so an id-class sweep does not "fix" it into a bug.
      contact_id: data.leadId && isValidUUID(data.leadId) ? data.leadId : null,
      type: data.sessionType,
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
    conversation_id: session.id,
    sender_type: "ai_assistant",
    body: data.leadId
      ? `I'm ready to help you engage with this lead using them-first communication. I have their profile loaded and can suggest personalized approaches.`
      : `I'm here to assist you. What would you like help with today?`,
    type: "system",
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
      conversation_id: data.sessionId,
      sender_type: isClientMessage ? "client" : "agent",
      sender_id: data.senderId,
      body: data.messageContent,
      them_first_analysis: themFirstAnalysis,
      compliance_flagged: !complianceCheck.passed,
      // compliance_issues is character varying[] — writing the structured
      // issue objects straight in fails with 42804 (verified live). The column
      // gets the human-readable labels it is typed for; the full detail is
      // preserved in metadata, which IS jsonb.
      compliance_issues: complianceIssueLabels(complianceCheck.issues),
      metadata: {
        ...(temperatureAnalysis
          ? {
              temperature: temperatureAnalysis.temperature,
              sentiment_score: temperatureAnalysis.score,
              sentiment: temperatureAnalysis.sentiment,
            }
          : {}),
        ...(complianceCheck.issues?.length ? { compliance_issues: complianceCheck.issues } : {}),
      },
    })
    .select("*, message_content:body, message_type:type")
    .single()

  if (error) throw error

  // Update session activity
  await supabase
    .from("conversations")
    .update({
      last_message_at: new Date().toISOString(),
      them_first_score: themFirstAnalysis.score,
    })
    .eq("id", data.sessionId)

  // Generate AI response if requested
  if (data.requestAiResponse) {
    const aiResponse = await generateAiResponse(data.sessionId, data.messageContent)

    await supabase.from("messages").insert({
      conversation_id: data.sessionId,
      sender_type: "ai_assistant",
      body: aiResponse.message,
      type: aiResponse.type,
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
    const currentChannel = session?.contact_channel || "email" // default to email
    const mentionsSMSOrCall = /\b(call|phone|text|sms|message)\b/gi.test(message)

    // Block if message mentions SMS/call AND current channel is not in allowed list
    if (mentionsSMSOrCall && !coldLeadChannels.includes(currentChannel)) {
      issues.push({
        type: "cold_lead_channel_violation",
        phrase: "Contact method mentioned",
        severity: "blocking",
        alternative: "Cold leads can only be contacted via email or print mail per compliance",
      })
    }
    
    // Also block if proposing to use disallowed channels
    if (!coldLeadChannels.includes(currentChannel) && mentionsSMSOrCall) {
      issues.push({
        type: "cold_lead_channel_violation",
        phrase: "Attempted contact outside allowed channels",
        severity: "blocking",
        alternative: "Switch to email or print mail for this cold lead",
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

  // Get session context.
  //
  // THIS IS WHERE THE BAD EMBED COST THE MOST. lead_intelligence and
  // lead_behavioral_data are keyed on lead_id and have NO foreign key to
  // contacts, so PostgREST refused the entire request (PGRST200). The error was
  // never destructured, `session` came back null, and `leadContext` below fell
  // to its "No lead selected" branch — EVERY TIME. The AI answered every message
  // knowing nothing about the contact, while the contact row sat one valid join
  // away. conversations.contact_id -> contacts is a real foreign key and always
  // was; it was the two unresolvable siblings that took the whole query down.
  const { data: session, error: sessionError } = await supabase
    .from("conversations")
    .select(`
      *,
      contacts (*)
    `)
    .eq("id", sessionId)
    .maybeSingle()

  if (sessionError) {
    // Silence here is what let the defect live. A context the AI cannot load is
    // worth saying out loud, because the reply it writes without it looks fine.
    console.error("[v0] AI response context load failed:", sessionError)
  }

  // Get conversation history
  const { data: messages } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(20)

  // Build context for AI
  const leadContext = session?.contacts
    ? `
Lead Information:
- Name: ${session.contacts.first_name} ${session.contacts.last_name}
- Temperature: ${session.contacts.lead_temperature}
- Interests: ${session.contacts.notes?.trim() || "Not identified"}
- Last Contact: ${session.contacts.last_contact_date || "Never"}
- Source: ${session.contacts.lead_source}
`
    : "No lead selected"

  const conversationHistory = messages?.map((m) => `${m.sender_type}: ${m.body}`).join("\n") || ""

  // THE PREFERENCE HAS TO REACH THE GENERATOR OR IT IS DECORATION.
  // agent_chat_preferences.preferred_model and .tone have existed for a long
  // time and nothing read them: the prompt below hardcoded gpt-4o-mini and
  // never mentioned tone, so an agent could set a style and see no difference.
  // The session row already carries agent_id, so no extra identity plumbing.
  const { data: prefRow } = session?.agent_id
    ? await supabase
        .from("agent_chat_preferences")
        .select("preferred_model, tone")
        .eq("agent_id", session.agent_id)
        .maybeSingle()
    : { data: null }
  const style = resolveReplyStyle(prefRow)

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

AGENT'S CHOSEN VOICE: ${style.toneDirective}

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
      model: style.model,
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
  
  // Get previous session lead temperature to consider history
  const supabase = await createClient()
  let session: any = null
  try {
    const result = await supabase
      .from("conversations")
      .select("lead_temperature")
      .eq("id", sessionId)
      .single()
    session = result.data
  } catch (err) {
    console.error("[v0] Error fetching session lead temperature:", err)
    session = null
  }
  
  // Start with score weighted by previous temperature
  let score = 50 // Start neutral
  if (session?.lead_temperature === "hot") {
    score += 15 // Boost if previously hot
  } else if (session?.lead_temperature === "cold") {
    score -= 15 // Lower expectations if previously cold
  }

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

/**
 * One chat session with its contact, its messages, and the AI suggestions
 * raised against it.
 *
 * THIS COULD NEVER RETURN. Three of the five embeds named a relationship
 * PostgREST cannot resolve, so the request failed as PGRST200 and the `throw`
 * below fired every single time — for any session id, always.
 *
 *   ai_suggestions   — embedded under conversations with NO foreign key to it.
 *                      The DATA link is real (ai_suggestions.session_id), it
 *                      just isn't declared, and PostgREST embeds on declared
 *                      relationships only. Fetched explicitly below instead.
 *   lead_intelligence
 *   lead_behavioral_data
 *                    — embedded under `contacts`, but both are keyed on
 *                      lead_id, not contact_id. Wrong on two counts: no FK, and
 *                      the wrong id space entirely (contacts and leads are
 *                      distinct id spaces here). There is no contact->lead
 *                      column on contacts, so a conversation's contact cannot
 *                      reach lead intelligence at all. Dropped rather than
 *                      pointed at a join that does not exist.
 *
 * The two embeds that remain are backed by real foreign keys —
 * conversations.contact_id -> contacts and messages.conversation_id ->
 * conversations.
 *
 * It also had NO auth gate and no tenant scope: a raw session id read any
 * brokerage's conversation, contact and message history. It has no callers
 * today, so nothing exploited it — but wiring it up in that state is how a
 * cross-tenant read ships.
 */
export async function getChatSession(sessionId: string) {
  if (!isValidUUID(sessionId)) return null

  const { brokerageId } = await getAgentContext()
  if (!brokerageId) return null

  const supabase = await createClient()

  const { data: session, error } = await supabase
    .from("conversations")
    .select(`
      *,
      contacts (*),
      messages (*, message_content:body, message_type:type)
    `)
    .eq("id", sessionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (error) throw error
  if (!session) return null

  // The link PostgREST could not see. Scoped by the same tenant anchor, so a
  // suggestion from another brokerage cannot ride in on a shared session id.
  const { data: suggestions, error: suggestionError } = await supabase
    .from("ai_suggestions")
    .select("*")
    .eq("session_id", sessionId)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  if (suggestionError) throw suggestionError

  return { ...session, ai_suggestions: suggestions ?? [] }
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
      session_type:type,
      last_activity_at:last_message_at,
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
    .eq("status", "active")
    .order("last_message_at", { ascending: false })

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
      status: "completed",
      ended_at: new Date().toISOString(),
    })
    .eq("id", sessionId)

  if (error) throw error

  revalidatePath("/dashboard/chat")
  return { success: true }
}

export async function searchConversationHistory(leadId: string, searchTerm?: string) {
  const supabase = await createClient()

  // lead_conversation_history was a writer-less legacy table (burn-down round 6 repoint) — messages
  // is the written store. In this file the "lead id" IS the contacts.id (see createChatSession which
  // does contacts.eq("id", data.leadId)); occurred_at→created_at, message_content→body.
  let query = supabase
    .from("messages")
    .select("*")
    .eq("contact_id", leadId)
    .order("created_at", { ascending: false })

  if (searchTerm) {
    query = query.ilike("body", `%${searchTerm}%`)
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

export async function applyChatTemplate(templateId: string, sessionId: string) {
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

  // THE COLUMN IS template_body, NOT template_content.
  // chat_templates carries template_name + template_body (verified live); the
  // old read of `template.template_content` was undefined, so every "apply
  // template" produced an empty message — and `undefined.replace(...)` threw
  // outright the moment the conversation had a contact on it. Personalisation
  // is global (replaceAll) because a body may use {first_name} more than once.
  let personalizedContent: string = template.template_body ?? ""
  if (session?.contacts) {
    personalizedContent = personalizedContent
      .replaceAll("{first_name}", session.contacts.first_name || "")
      .replaceAll("{last_name}", session.contacts.last_name || "")
      .replaceAll("{city}", session.contacts.city || "")
  }

  return {
    template,
    personalizedContent,
  }
}

// =====================================================
// AGENT PREFERENCES
// =====================================================

export interface AgentChatPreferences {
  preferred_model: ReplyModel
  tone: ReplyTone
  /** Free-form extras. The jsonb column, not loose top-level keys. */
  preferences: Record<string, unknown>
}

/**
 * Save an agent's AI reply style.
 *
 * TWO THINGS WERE WRONG HERE.
 *
 * (1) `upsert` with no conflict target defaults to the PRIMARY KEY. No id is
 *     supplied, so a fresh uuid is generated every call, ON CONFLICT (id) never
 *     fires, and the SECOND save hits UNIQUE (agent_id). Confirmed live:
 *     23505 on the second insert, and `on conflict (agent_id)` updating in
 *     place. An agent could set their preferences exactly once.
 *
 * (2) the old signature took `preferences: any` and SPREAD it across the row,
 *     so any key the caller invented became a column that does not exist —
 *     including the very keys the reader below used to hand back as defaults.
 */
export async function updateAgentChatPreferences(
  agentId: string,
  input: Partial<AgentChatPreferences>,
) {
  const supabase = await createClient()

  if (!isValidUUID(agentId)) throw new Error("Invalid agent id")

  // agent_chat_preferences.agent_id is FK to agents.id — resolve the brokerage
  // from the agent row rather than trusting a caller-supplied anchor.
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("brokerage_id")
    .eq("id", agentId)
    .maybeSingle()
  if (agentError) throw agentError
  if (!agent) throw new Error("No agent record found for that id")

  // Only values the drafting path can honour are stored. A tone or model the
  // generator does not recognise would silently degrade every reply.
  const row: Record<string, unknown> = {
    agent_id: agentId,
    brokerage_id: agent.brokerage_id,
    updated_at: new Date().toISOString(),
  }
  if (input.preferred_model !== undefined) {
    if (!isReplyModel(input.preferred_model)) throw new Error("Unsupported reply model")
    row.preferred_model = input.preferred_model
  }
  if (input.tone !== undefined) {
    if (!isReplyTone(input.tone)) throw new Error("Unsupported reply tone")
    row.tone = input.tone
  }
  if (input.preferences !== undefined) row.preferences = input.preferences

  const { error } = await supabase
    .from("agent_chat_preferences")
    .upsert(row, { onConflict: "agent_id" })

  if (error) throw error

  revalidatePath("/dashboard/settings/assistant")
  return { success: true }
}

/**
 * Read an agent's AI reply style.
 *
 * The fallback used to return six keys — auto_suggest_responses,
 * them_first_coaching, compliance_alerts, lead_insights_enabled,
 * preferred_tone, custom_prompts — NONE of which are columns on this table. So
 * this function returned one shape when no row existed and a completely
 * different shape the moment the agent saved, and no consumer could be written
 * against both. The defaults now describe the real row.
 */
export async function getAgentChatPreferences(agentId: string): Promise<AgentChatPreferences> {
  const supabase = await createClient()

  if (!isValidUUID(agentId)) {
    return { preferred_model: DEFAULT_REPLY_MODEL, tone: DEFAULT_REPLY_TONE, preferences: {} }
  }

  const { data, error } = await supabase
    .from("agent_chat_preferences")
    .select("preferred_model, tone, preferences")
    .eq("agent_id", agentId)
    .maybeSingle()

  if (error) throw error

  const style = resolveReplyStyle(data)
  return {
    preferred_model: style.model,
    tone: style.tone,
    preferences: (data?.preferences as Record<string, unknown> | null) ?? {},
  }
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

  // UNIQUE (conversation_id, user_id) — without naming it, upsert falls back to
  // the primary key, a new uuid is generated, and re-granting access to the
  // same person raises 23505 instead of updating their permissions.
  const { error } = await supabase.from("message_access_control").upsert(
    {
      conversation_id: data.conversationId,
      user_id: data.userId,
      user_type: data.userType,
      can_read: data.canRead ?? true,
      can_write: data.canWrite ?? true,
      granted_by: data.grantedBy,
      expires_at: data.expiresAt,
      granted_at: new Date().toISOString(),
    },
    { onConflict: "conversation_id,user_id" },
  )

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

  // NO FOREIGN KEY from message_access_control.user_id to users, so PostgREST
  // cannot resolve a `users(...)` embed — the previous version of this read
  // threw on every call. Two queries instead of a join we are not entitled to.
  const { data, error } = await supabase
    .from("message_access_control")
    .select("*")
    .eq("conversation_id", conversationId)

  if (error) throw error
  const rows = data ?? []
  if (rows.length === 0) return []

  const { data: users, error: usersError } = await supabase
    .from("users")
    .select("id, first_name, last_name, email")
    .in("id", rows.map((r) => r.user_id))

  if (usersError) throw usersError
  const byId = new Map((users ?? []).map((u) => [u.id, u]))

  return rows.map((r) => ({ ...r, users: byId.get(r.user_id) ?? null }))
}

// =====================================================
// ADDITIONAL EXPORTS
// =====================================================

// getChatSessions(userId) was a three-line alias for getAgentChatSessions, and
// it encoded an identity-space bug in its own signature: it took a users.id and
// handed it to a filter on agent_id. Those are different id spaces, so any
// caller passing a real user id got a silent empty list. Zero callers. Deleted
// — getAgentChatSessions(agentId) is the replacement, and it wants agents.id.

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
