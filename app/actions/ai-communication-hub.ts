"use server"

import { createClient } from "@/lib/supabase/server"
import { generateText, generateObject } from "ai"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"

/**
 * AI Communication Hub
 * Unified messaging with sentiment analysis, smart drafting, and communication insights
 */

const SentimentSchema = z.object({
  sentiment: z.enum(["very_positive", "positive", "neutral", "negative", "very_negative", "urgent"]),
  confidence: z.number().min(0).max(1),
  emotions: z.array(z.string()),
  urgency: z.enum(["low", "medium", "high", "critical"]),
  intent: z.string(),
  suggestedPriority: z.number().min(1).max(5),
  keyTopics: z.array(z.string()),
  requiresImmediateAction: z.boolean(),
  suggestedResponse: z.string().optional(),
})

// Get conversations/messages for inbox
export async function getConversations(params: {
  brokerageId: string
  contactId?: string
  limit?: number
  unreadOnly?: boolean
  channel?: string
}) {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("conversations")
      .select(`
        *,
        contacts(id, first_name, last_name, email, phone, lifecycle_state, lead_score),
        agents(id, user_id, users(first_name, last_name))
      `)
      .eq("brokerage_id", params.brokerageId)
      .order("last_message_at", { ascending: false })
      .limit(params.limit ?? 50)

    if (params.unreadOnly) {
      query = query.gt("unread_count", 0)
    }

    if (params.contactId) {
      query = query.eq("contact_id", params.contactId)
    }

    if (params.channel) {
      query = query.eq("type", params.channel)
    }

    const { data: conversations, error } = await query

    if (error) throw error

    return {
      success: true,
      conversations: conversations ?? [],
      total: conversations?.length ?? 0,
    }
  } catch (error) {
    return handleError(error, "getConversations")
  }
}

// Get all messages in a conversation thread
export async function getMessageThread(conversationId: string) {
  try {
    const supabase = await createClient()

    const { data: messages, error } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })

    if (error) throw error

    return { success: true, messages: messages ?? [] }
  } catch (error) {
    return handleError(error, "getMessageThread")
  }
}

// Mark a conversation as read
export async function markConversationRead(conversationId: string) {
  try {
    const supabase = await createClient()

    const { error } = await supabase
      .from("conversations")
      .update({ unread_count: 0, updated_at: new Date().toISOString() })
      .eq("id", conversationId)

    if (error) throw error

    revalidatePath("/dashboard/communication")
    return { success: true }
  } catch (error) {
    return handleError(error, "markConversationRead")
  }
}

// Analyze message sentiment
export async function analyzeMessageSentiment(params: {
  message: string
  contactId?: string
  conversationHistory?: string[]
  agentId: string
}) {
  try {
    const { object: analysis } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: SentimentSchema,
      prompt: `Analyze the sentiment and intent of this real estate communication:

MESSAGE: "${params.message}"

${params.conversationHistory ? `RECENT CONVERSATION HISTORY:
${params.conversationHistory.slice(-5).join("\n")}` : ""}

Consider:
1. Overall sentiment (positive to negative scale)
2. Emotional state (excited, anxious, frustrated, etc.)
3. Urgency level
4. Primary intent (inquiry, complaint, request, update, etc.)
5. Key topics mentioned
6. Whether immediate action/response is needed
7. Brief suggested response approach`,
    })

    return { success: true, analysis }
  } catch (error) {
    return handleError(error, "analyzeMessageSentiment")
  }
}

// Generate smart response draft
export async function generateSmartResponse(params: {
  incomingMessage: string
  contactId: string
  agentId: string
  channel: "email" | "sms" | "chat"
  tone?: "formal" | "friendly" | "professional" | "empathetic"
  includeNextSteps?: boolean
}) {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid contact or agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get contact context
    const { data: contact } = await supabase
      .from("contacts")
      .select("*, transactions(*), interactions(*)")
      .eq("id", params.contactId)
      .single()

    // Get agent's communication style
    const { data: agentProfile } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("agent_id", params.agentId)
      .maybeSingle()

    // Get conversation history
    const { data: recentMessages } = await supabase
      .from("messages")
      .select("*")
      .eq("contact_id", params.contactId)
      .order("created_at", { ascending: false })
      .limit(10)

    const charLimit = params.channel === "sms" ? 160 : params.channel === "chat" ? 500 : 2000

    const { text: response } = await generateText({
      model: "openai/gpt-4o",
      prompt: `Generate a ${params.tone || "professional"} response for this ${params.channel} message.

INCOMING MESSAGE: "${params.incomingMessage}"

CONTACT CONTEXT:
- Name: ${contact?.first_name} ${contact?.last_name}
- Type: ${contact?.contact_type || "Unknown"}
- Persona: ${contact?.contact_persona || "General"}
- Stage: ${contact?.pipeline_stage || "Unknown"}
- Active Transactions: ${contact?.transactions?.filter((t: any) => t.status === "active").length || 0}

AGENT VOICE:
${agentProfile ? `
- Tone: ${agentProfile.tone}
- Style: ${agentProfile.writing_style}
- Signature phrases: ${agentProfile.signature_phrases?.join(", ")}
` : "Use professional, friendly tone"}

RECENT CONVERSATION:
${recentMessages?.map(m => `${m.direction === "inbound" ? "Client" : "Agent"}: ${m.content?.substring(0, 100)}`).join("\n") || "No history"}

REQUIREMENTS:
- Channel: ${params.channel} (max ${charLimit} characters)
- ${params.includeNextSteps ? "Include clear next steps" : ""}
- Be helpful, warm, and action-oriented
- Address their specific concern
- If SMS, be concise but complete

Generate ONLY the response message, no explanations.`,
    })

    // Analyze the response we generated
    const sentimentResult = await analyzeMessageSentiment({
      message: response,
      agentId: params.agentId,
    })

    return {
      success: true,
      draft: response,
      characterCount: response.length,
      channel: params.channel,
      sentiment: sentimentResult.analysis,
    }
  } catch (error) {
    return handleError(error, "generateSmartResponse")
  }
}

// Analyze conversation health
export async function analyzeConversationHealth(params: {
  contactId: string
  agentId: string
}) {
  const supabase = await createClient()

  try {
    // Get all messages for this contact
    const { data: messages } = await supabase
      .from("messages")
      .select("*")
      .eq("contact_id", params.contactId)
      .order("created_at", { ascending: true })

    if (!messages || messages.length === 0) {
      return { success: true, health: null, message: "No conversation history" }
    }

    // Analyze patterns
    const inbound = messages.filter(m => m.direction === "inbound")
    const outbound = messages.filter(m => m.direction === "outbound")
    const avgResponseTime = calculateAvgResponseTime(messages)

    const { object: health } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        overallHealth: z.enum(["excellent", "good", "fair", "poor", "critical"]),
        healthScore: z.number().min(0).max(100),
        engagementLevel: z.enum(["highly_engaged", "engaged", "passive", "disengaged", "at_risk"]),
        sentimentTrend: z.enum(["improving", "stable", "declining"]),
        communicationBalance: z.string(),
        responsiveness: z.string(),
        keyInsights: z.array(z.string()),
        riskFactors: z.array(z.string()),
        recommendations: z.array(z.string()),
        suggestedNextOutreach: z.object({
          timing: z.string(),
          channel: z.string(),
          topic: z.string(),
        }),
      }),
      prompt: `Analyze this real estate client conversation health:

CONVERSATION STATS:
- Total messages: ${messages.length}
- Client messages: ${inbound.length}
- Agent messages: ${outbound.length}
- Avg response time: ${avgResponseTime} hours
- Conversation span: ${getConversationSpan(messages)} days

RECENT MESSAGES (last 10):
${messages.slice(-10).map(m => `[${m.direction}] ${m.content?.substring(0, 100)}`).join("\n")}

Assess:
1. Overall relationship health
2. Client engagement level
3. Sentiment trend over time
4. Communication balance (is agent responsive enough?)
5. Risk factors (going cold, frustration, etc.)
6. Recommendations for improvement
7. Best next outreach timing/topic`,
    })

    return { success: true, health }
  } catch (error) {
    return handleError(error, "analyzeConversationHealth")
  }
}

// Prioritize inbox messages
export async function prioritizeInbox(params: {
  agentId: string
  limit?: number
}) {
  const supabase = await createClient()

  try {
    // Get unread/unresponded messages
    const { data: messages } = await supabase
      .from("messages")
      .select("*, contacts(*)")
      .eq("agent_id", params.agentId)
      .eq("direction", "inbound")
      .eq("responded", false)
      .order("created_at", { ascending: false })
      .limit(params.limit || 50)

    if (!messages || messages.length === 0) {
      return { success: true, prioritizedMessages: [], message: "Inbox clear!" }
    }

    // Analyze and prioritize each message
    const prioritized = await Promise.all(
      messages.map(async (msg) => {
        const sentiment = await analyzeMessageSentiment({
          message: msg.content || "",
          contactId: msg.contact_id,
          agentId: params.agentId,
        })

        return {
          ...msg,
          analysis: sentiment.analysis,
          priority: sentiment.analysis?.suggestedPriority || 3,
        }
      })
    )

    // Sort by priority (1 = highest)
    const sorted = prioritized.sort((a, b) => a.priority - b.priority)

    return {
      success: true,
      prioritizedMessages: sorted,
      summary: {
        total: sorted.length,
        critical: sorted.filter(m => m.analysis?.urgency === "critical").length,
        highPriority: sorted.filter(m => m.priority <= 2).length,
        requiresAction: sorted.filter(m => m.analysis?.requiresImmediateAction).length,
      },
    }
  } catch (error) {
    return handleError(error, "prioritizeInbox")
  }
}

// Generate communication summary for contact
export async function generateCommunicationSummary(params: {
  contactId: string
  agentId: string
  timeframe?: "week" | "month" | "all"
}) {
  const supabase = await createClient()

  try {
    let query = supabase
      .from("messages")
      .select("*")
      .eq("contact_id", params.contactId)
      .order("created_at", { ascending: true })

    if (params.timeframe === "week") {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      query = query.gte("created_at", weekAgo)
    } else if (params.timeframe === "month") {
      const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      query = query.gte("created_at", monthAgo)
    }

    const { data: messages } = await query

    if (!messages || messages.length === 0) {
      return { success: true, summary: "No communications in this timeframe" }
    }

    const { text: summary } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Summarize this client communication history for an agent's quick reference:

MESSAGES (${messages.length} total):
${messages.map(m => `[${new Date(m.created_at).toLocaleDateString()}] ${m.direction === "inbound" ? "CLIENT" : "AGENT"}: ${m.content?.substring(0, 200)}`).join("\n\n")}

Provide:
1. Brief summary of key discussion points
2. Client's main concerns or interests
3. Any commitments made by either party
4. Outstanding questions or issues
5. Recommended follow-up actions`,
    })

    return { success: true, summary }
  } catch (error) {
    return handleError(error, "generateCommunicationSummary")
  }
}

// Helper functions
function calculateAvgResponseTime(messages: any[]): number {
  let totalTime = 0
  let count = 0

  for (let i = 1; i < messages.length; i++) {
    if (messages[i].direction !== messages[i - 1].direction) {
      const diff = new Date(messages[i].created_at).getTime() - new Date(messages[i - 1].created_at).getTime()
      totalTime += diff
      count++
    }
  }

  return count > 0 ? Math.round(totalTime / count / (1000 * 60 * 60)) : 0
}

function getConversationSpan(messages: any[]): number {
  if (messages.length < 2) return 0
  const first = new Date(messages[0].created_at).getTime()
  const last = new Date(messages[messages.length - 1].created_at).getTime()
  return Math.round((last - first) / (1000 * 60 * 60 * 24))
}
