"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateObject } from "@/lib/ai/generate"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { resolveModel } from "@/lib/ai/resolve-model"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"
import { dispatchEmail, dispatchSms } from "@/lib/providers/dispatch"
import { checkSuppression } from "@/lib/kernel/compliance/check-suppression"

/**
 * AI Communication Hub
 * Unified messaging with sentiment analysis, smart drafting, and communication insights
 *
 * Auth model: every action in this file was previously unauthenticated and
 * trusted caller-supplied agentId / contactId / conversationId / brokerageId.
 * Any signed-in user could send messages under another agent's identity,
 * read any brokerage's inbox, burn AI inference budget, and trigger paid
 * email/SMS dispatch to arbitrary phone numbers.
 *
 * Now: all 9 exported functions resolve identity from the session via
 * requireCaller() and verify the target entity (contact, conversation,
 * agent) belongs to the caller's brokerage before any read, write, or
 * AI inference.
 */

async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string; agentId: string | null }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  const { data: a } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id, agentId: a?.id ?? null }
}

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

// Send a message in a conversation
export async function sendMessage(params: {
  conversationId: string
  contactId: string
  agentId?: string           // ignored — derived from session
  channel: "email" | "sms" | "in_app"
  body: string
  subject?: string
  attachmentUrls?: string[]
}) {
  try {
    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }
    if (!auth.agentId) return { success: false, error: "Caller is not an agent" }

    const supabase = await createClient()
    const svc = createServiceClient()

    // Verify the conversation + contact both belong to caller's brokerage
    const { data: convo } = await svc
      .from("conversations")
      .select("brokerage_id")
      .eq("id", params.conversationId)
      .maybeSingle()
    if (!convo) return { success: false, error: "Conversation not found" }
    if (convo.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }

    const { data: contactOwn } = await svc
      .from("contacts")
      .select("brokerage_id")
      .eq("id", params.contactId)
      .maybeSingle()
    if (!contactOwn || contactOwn.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    const callerAgentId = auth.agentId  // use session-resolved agent id, ignore callerAgentId
    const now = new Date().toISOString()

    // Step 1: INSERT into messages — stamp brokerage_id for billing rollups
    const { data: message, error: msgError } = await supabase
      .from("messages")
      .insert({
        conversation_id:  params.conversationId,
        contact_id:       params.contactId,
        agent_id:         callerAgentId,
        brokerage_id:     auth.brokerageId,
        type:             params.channel,
        direction:        "outbound",
        body:             params.body,
        subject:          params.subject ?? null,
        status:           "sent",
        attachment_urls:  params.attachmentUrls ?? [],
        created_at:       now,
        updated_at:       now,
      })
      .select()
      .single()

    if (msgError) throw msgError

    // Step 2: UPDATE conversations — bump last_message_at + message_count
    // Read current count first (RPC not required — simple read-increment-write)
    const { data: convRow } = await supabase
      .from("conversations")
      .select("message_count")
      .eq("id", params.conversationId)
      .single()

    await supabase
      .from("conversations")
      .update({
        last_message_at: now,
        updated_at:      now,
        message_count:   (convRow?.message_count ?? 0) + 1,
      })
      .eq("id", params.conversationId)

    // Step 3: Dispatch via provider layer
    let dispatchResult: { success: boolean; messageId?: string; error?: string; providerKey: string } = {
      success: true,
      providerKey: "in_app",
    }

    if (params.channel === "email") {
      // Fetch contact email for dispatch
      const { data: contact } = await supabase
        .from("contacts")
        .select("email, first_name, last_name")
        .eq("id", params.contactId)
        .single()

      if (contact?.email) {
        // Fetch agent brokerage_id for dispatch context
        const { data: agent } = await supabase
          .from("agents")
          .select("brokerage_id")
          .eq("id", callerAgentId)
          .single()

        // assembleEmail() runs inside dispatchEmail() — do NOT call it here.
        dispatchResult = await dispatchEmail({
          brokerageId:    agent?.brokerage_id ?? "",
          agentId:        callerAgentId,
          from:           "noreply@platform.com",
          to:             contact.email,
          subject:        params.subject ?? "(No Subject)",
          html:           `<p>${params.body}</p>`,
          channelPurpose: "conversation",
          systemSource:   "inbox",
          leadId:         params.contactId,
        })
      }
    } else if (params.channel === "sms") {
      const { data: contact } = await supabase
        .from("contacts")
        .select("phone, tcpa_consent, brokerage_id")
        .eq("id", params.contactId)
        .maybeSingle()

      if (!contact?.phone) {
        return { success: false, error: "Contact has no phone number on file." }
      }

      // ── TCPA hard gate: contacts must have explicit opt-in before SMS dispatch ──
      if (!contact.tcpa_consent) {
        return {
          success: false,
          error: "TCPA: This contact has not opted in to SMS. Obtain written consent before sending.",
          tcpaBlocked: true,
        }
      }

      // Suppression check (DNC registry, opt-out list)
      const suppression = await checkSuppression({
        brokerageId: contact.brokerage_id,
        contactId: params.contactId,
        channel: "sms",
        phone: contact.phone,
      })
      if (suppression.suppressed) {
        return { success: false, error: `SMS suppressed: ${suppression.reason}`, suppressed: true }
      }

      const { data: agent } = await supabase
        .from("agents")
        .select("brokerage_id")
        .eq("id", callerAgentId)
        .maybeSingle()

      dispatchResult = await dispatchSms({
        brokerageId: agent?.brokerage_id ?? contact.brokerage_id ?? "",
        agentId:     callerAgentId,
        to:          contact.phone,
        message:     params.body,
        systemSource: "inbox",
        contactId:   params.contactId,
      })
    }

    // Step 4: Fire-and-forget message_provider_logs
    const serviceClient = createServiceClient()
    const { data: agentForLog } = await supabase
      .from("agents")
      .select("brokerage_id")
      .eq("id", callerAgentId)
      .single()

    // Fire-and-forget: log message provider activity without blocking response
    ;(async () => {
      try {
        await serviceClient.from("message_provider_logs").insert({
          brokerage_id:        agentForLog?.brokerage_id ?? null,
          message_id:          message.id,
          provider_key:        dispatchResult.providerKey,
          channel:             params.channel,
          direction:           "outbound",
          provider_message_id: dispatchResult.messageId ?? null,
          provider_status:     dispatchResult.success ? "sent" : "failed",
          error_message:       dispatchResult.error ?? null,
          // message_provider_logs timestamp column is sent_at (defaults now()) — no created_at.
        })
      } catch (err) {
        // Silent fail for logging - don't block message send on log failure
      }
    })()

    revalidatePath("/dashboard/communications/inbox")
    return { success: true, message }
  } catch (error) {
    return handleError(error, "sendMessage")
  }
}

// Get conversations/messages for inbox
export async function getConversations(params: {
  brokerageId?: string  // ignored — derived from session
  contactId?: string
  limit?: number
  unreadOnly?: boolean
  channel?: string
}) {
  try {
    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error, conversations: [], total: 0 }

    const supabase = await createClient()

    let query = supabase
      .from("conversations")
      .select(`
        *,
        contacts(id, first_name, last_name, email, phone, lifecycle_state, lead_score, tcpa_consent, preferred_channel, call_stop_flag),
        agents(id, user_id, users(first_name, last_name)),
        messages!messages_conversation_id_fkey(body, created_at, direction)
      `)
      .eq("brokerage_id", auth.brokerageId)
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

    // Derive last_message_preview from the joined messages array (newest first)
    const mapped = (conversations ?? []).map((c: any) => {
      const msgs: any[] = c.messages ?? []
      const sorted = [...msgs].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
      const preview = sorted[0]?.body ?? null
      return { ...c, last_message_preview: preview, messages: undefined }
    })

    return {
      success: true,
      conversations: mapped,
      total: mapped.length,
    }
  } catch (error) {
    return handleError(error, "getConversations")
  }
}

// Get all messages in a conversation thread
export async function getMessageThread(conversationId: string) {
  try {
    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error, messages: [] }

    const supabase = await createClient()

    // Verify conversation belongs to caller's brokerage
    const { data: convo } = await supabase
      .from("conversations")
      .select("brokerage_id, contact_id")
      .eq("id", conversationId)
      .maybeSingle()
    if (!convo) return { success: false, error: "Conversation not found", messages: [] }
    if (convo.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden", messages: [] }

    const { data: messages, error } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })

    if (error) throw error

    // Unified inbox: fold this contact's CALL TRANSCRIPTS into the thread so the
    // agent sees calls inline alongside email/sms/chat ("see call transcripts"),
    // instead of leaving the inbox to find them. Read-only, brokerage-scoped; only
    // calls that actually have a transcript or summary are shown.
    let callRows: any[] = []
    if (convo.contact_id) {
      const { data: calls } = await supabase
        .from("voice_calls")
        .select("id, direction, status, duration_seconds, transcription, summary, sentiment, started_at, ended_at, created_at")
        .eq("contact_id", convo.contact_id)
        .eq("brokerage_id", auth.brokerageId)
      callRows = (calls ?? [])
        .filter((c: any) => (c.transcription && c.transcription.trim()) || (c.summary && c.summary.trim()))
        .map((c: any) => {
          const mins = c.duration_seconds ? ` · ${Math.max(1, Math.round(c.duration_seconds / 60))} min` : ""
          const dir = c.direction === "outbound" ? "Outbound call" : "Inbound call"
          const body = [
            `📞 ${dir}${c.status ? ` · ${c.status}` : ""}${mins}`,
            c.summary ? `\nSummary: ${c.summary.trim()}` : null,
            c.transcription ? `\n\nTranscript:\n${c.transcription.trim()}` : null,
          ].filter(Boolean).join("")
          return {
            id: `call-${c.id}`,
            conversation_id: conversationId,
            contact_id: convo.contact_id,
            type: "voice",
            direction: c.direction ?? "inbound",
            sender_type: "ai_assistant",
            subject: "Call transcript",
            body,
            content: body,
            sentiment: c.sentiment ?? null,
            status: "read",
            is_call_transcript: true,
            created_at: c.ended_at ?? c.started_at ?? c.created_at,
          }
        })
    }

    const merged = [...(messages ?? []), ...callRows].sort(
      (a: any, b: any) =>
        new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime(),
    )

    return { success: true, messages: merged }
  } catch (error) {
    return handleError(error, "getMessageThread")
  }
}

// Mark a conversation as read
export async function markConversationRead(conversationId: string) {
  try {
    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = await createClient()

    // Verify conversation belongs to caller's brokerage
    const { data: convo } = await supabase
      .from("conversations")
      .select("brokerage_id")
      .eq("id", conversationId)
      .maybeSingle()
    if (!convo) return { success: false, error: "Conversation not found" }
    if (convo.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }

    const { error } = await supabase
      .from("conversations")
      .update({ unread_count: 0, updated_at: new Date().toISOString() })
      .eq("id", conversationId)
      .eq("brokerage_id", auth.brokerageId)

    if (error) throw error

    revalidatePath("/dashboard/communications")
    revalidatePath("/dashboard/communications/inbox")
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
  agentId?: string  // ignored — derived from session
}) {
  try {
    // Auth gate — burns paid AI inference
    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const { object: analysis } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
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
  agentId?: string  // ignored — derived from session
  brokerageId?: string  // ignored — derived from session
  channel: "email" | "sms" | "chat"
  tone?: "formal" | "friendly" | "professional" | "empathetic"
  includeNextSteps?: boolean
}) {
  // Auth gate — paid AI inference + contact PII access
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  // NOT `?? auth.userId` (m360) — brand_voice_profile and messages are both
  // agents-class, so the substitution read an empty voice profile and an empty
  // message history and presented both as the agent's real state.
  const effAgentId = auth.agentId
  if (!effAgentId) return { success: false, error: "No agent profile for this user yet — finish account setup." }
  const effBrokerageId = auth.brokerageId

  if (!isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  const supabase = await createClient()

  try {
    // Get contact context — must belong to caller's brokerage
    const { data: contact } = await supabase
      .from("contacts")
      .select("first_name, last_name, contact_type, contact_persona")
      .eq("id", params.contactId)
      .eq("brokerage_id", effBrokerageId)
      .maybeSingle()
    if (!contact) return { success: false, error: "Contact not found" }

    // Get agent's communication style
    const { data: agentProfile } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("agent_id", effAgentId)
      .eq("brokerage_id", effBrokerageId)
      .maybeSingle()

    // Get conversation history
    const { data: recentMessages } = await supabase
      .from("messages")
      .select("*")
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", effBrokerageId)
      .order("created_at", { ascending: false })
      .limit(10)

    const charLimit = params.channel === "sms" ? 160 : params.channel === "chat" ? 500 : 2000

    const { text: response } = await generateText({
      feature: "smart_reply_generation",
      prompt: `Generate a ${params.tone || "professional"} response for this ${params.channel} message.

INCOMING MESSAGE: "${params.incomingMessage}"

CONTACT CONTEXT:
- Name: ${contact?.first_name} ${contact?.last_name}
- Type: ${contact?.contact_type || "Unknown"}
- Persona: ${contact?.contact_persona || "General"}

AGENT VOICE:
${agentProfile ? `
- Tone: ${agentProfile.tone}
- Preferred words: ${agentProfile.preferred_words?.join(", ") || "none specified"}
- Key messages: ${agentProfile.key_brand_messages?.join("; ") || "none specified"}
` : "Use professional, friendly tone"}

RECENT CONVERSATION:
${recentMessages?.map(m => `${m.direction === "inbound" ? "Client" : "Agent"}: ${(m.body ?? "").substring(0, 100)}`).join("\n") || "No history"}

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
      agentId: effAgentId,
    })

    // Union narrowing: check success before accessing analysis
    const sentimentAnalysis = sentimentResult.success ? sentimentResult.analysis : null

    // Log AI response generation for brokerage audit trail per Kernel OS contract
    // Fire-and-forget to avoid blocking response
    ;(async () => {
      try {
        // audit_log has no brokerage_id column; user_id is the auth user id
        await supabase
          .from("audit_log")
          .insert({
            action: "ai_response_generated",
            entity_type: "message",
            entity_id: params.contactId,
            user_id: auth.userId,
            after: {
              channel: params.channel,
              tone: params.tone || "professional",
              characterCount: response.length,
              sentiment: sentimentAnalysis,
              brokerage_id: effBrokerageId,
            },
          })
      } catch (err) {
        // Silent fail - audit logging should not block response generation
      }
    })()

    return {
      success: true,
      draft: response,
      characterCount: response.length,
      channel: params.channel,
      sentiment: sentimentAnalysis,
    }
  } catch (error) {
    return handleError(error, "generateSmartResponse")
  }
}

// Analyze conversation health
export async function analyzeConversationHealth(params: {
  contactId: string
  agentId?: string  // ignored — derived from session
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error, health: null }

  const supabase = await createClient()

  try {
    // Verify contact belongs to caller's brokerage
    const { data: contactOwn } = await supabase
      .from("contacts")
      .select("brokerage_id")
      .eq("id", params.contactId)
      .maybeSingle()
    if (!contactOwn) return { success: false, error: "Contact not found", health: null }
    if (contactOwn.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden", health: null }
    }

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
      model: resolveModel("openai/gpt-4o-mini"),
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
${messages.slice(-10).map(m => `[${m.direction}] ${m.body?.substring(0, 100)}`).join("\n")}

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
  agentId?: string  // ignored — derived from session
  limit?: number
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error, prioritizedMessages: [] }
  if (!auth.agentId) return { success: true, prioritizedMessages: [], message: "Caller is not an agent" }
  const effAgentId = auth.agentId

  const supabase = await createClient()

  try {
    // Get unread/unresponded messages — scoped to caller's agent record
    const { data: messages } = await supabase
      .from("messages")
      // messages has no `responded` column — inbound + recency approximates the
      // unanswered queue.
      .select("*, contacts(*)")
      .eq("agent_id", effAgentId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(params.limit || 50)

    if (!messages || messages.length === 0) {
      return { success: true, prioritizedMessages: [], message: "Inbox clear!" }
    }

    // Analyze and prioritize each message
    const prioritized = await Promise.all(
      messages.map(async (msg) => {
        const sentiment = await analyzeMessageSentiment({
          message: msg.body || "",
          contactId: msg.contact_id,
          agentId: effAgentId,
        })

        // Union narrowing: check success before accessing analysis
        if (!sentiment.success || !sentiment.analysis) {
          return {
            ...msg,
            analysis: null,
            priority: 3, // default priority if analysis fails
          }
        }

        return {
          ...msg,
          analysis: sentiment.analysis,
          priority: sentiment.analysis.suggestedPriority || 3,
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
  agentId?: string  // ignored — derived from session
  timeframe?: "week" | "month" | "all"
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  try {
    // Verify contact belongs to caller's brokerage
    const { data: contactOwn } = await supabase
      .from("contacts")
      .select("brokerage_id")
      .eq("id", params.contactId)
      .maybeSingle()
    if (!contactOwn) return { success: false, error: "Contact not found" }
    if (contactOwn.brokerage_id !== auth.brokerageId) return { success: false, error: "Forbidden" }

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
      feature: "communication_summary_generation",
      prompt: `Summarize this client communication history for an agent's quick reference:

MESSAGES (${messages.length} total):
${messages.map(m => `[${new Date(m.created_at).toLocaleDateString()}] ${m.direction === "inbound" ? "CLIENT" : "AGENT"}: ${m.body?.substring(0, 200)}`).join("\n\n")}

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
