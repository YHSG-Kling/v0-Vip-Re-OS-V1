"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import { handleError } from "@/lib/errors"

// ─── Auth helper ──────────────────────────────────────────────────────────────
// markMessagesRead / getPortalMessages / generateAIDraft previously did an
// auth.getUser() check but never verified the contactId belonged to the
// caller. Any signed-in user could read/mutate/AI-draft messages for any
// contact in the database. This helper enforces ownership the same way
// sendPortalMessage already does — contact-self or agent in same brokerage.
async function requireContactAccess(contactId: string): Promise<
  | { ok: true; userId: string; brokerageId: string; isContactSelf: boolean }
  | { ok: false; error: string }
> {
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("brokerage_id, contact_user_id, email")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact || !contact.brokerage_id) return { ok: false, error: "Contact not found" }

  const isContactSelf =
    contact.contact_user_id === authUser.id ||
    !!(contact.email && authUser.email && contact.email.toLowerCase() === authUser.email.toLowerCase())

  if (isContactSelf) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: true }
  }

  const { data: callerRow } = await svc
    .from("users").select("brokerage_id, user_type").eq("id", authUser.id).maybeSingle()
  if (callerRow?.brokerage_id === contact.brokerage_id && ["agent","team_lead","tc","admin","broker","superadmin"].includes(((callerRow as any)?.user_type) ?? "")) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: false }
  }

  return { ok: false, error: "Forbidden" }
}

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface PortalMessage {
  id: string
  contact_id: string
  agent_id: string
  brokerage_id: string
  body: string
  direction: "agent_to_client" | "client_to_agent"
  channel: string
  read: boolean
  created_at: string
  read_at: string | null
  transaction_id?: string | null
}

export interface SendMessageParams {
  contactId: string
  messageBody: string
  direction: "agent_to_client" | "client_to_agent"
  /** Communication channel — used for unified inbox filtering. Defaults to 'portal'. */
  channel?: string
  transactionId?: string
}

export interface MarkReadParams {
  contactId: string
  /** When agent is viewing, pass "client_to_agent" to mark client messages as read.
   *  When contact is viewing, pass "agent_to_client" to mark agent messages as read. */
  direction: "agent_to_client" | "client_to_agent"
}

// ─── SERVER ACTIONS ───────────────────────────────────────────────────────────

/**
 * Send a portal message from agent to contact or vice versa.
 * Validates auth/session, resolves agentId, validates access and content.
 */
export async function sendPortalMessage(params: SendMessageParams): Promise<{
  success: boolean
  message?: PortalMessage
  error?: string
}> {
  try {
    const supabase = await createClient()

    // Validate auth
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return { success: false, error: "Unauthorized" }
    }

    const { contactId, messageBody, direction, channel = "portal", transactionId } = params

    // Validate message body
    if (!messageBody || messageBody.trim().length === 0) {
      return { success: false, error: "Message body cannot be empty" }
    }
    if (messageBody.length > 2000) {
      return { success: false, error: "Message body cannot exceed 2000 characters" }
    }

    // Resolve agent identity (never use user.id for agent_id column)
    const agentId = await resolveAgentId(supabase, user.id)
    if (!agentId) {
      return { success: false, error: "Agent profile not found" }
    }

    // Validate access to this contact — maybeSingle() so missing rows don't throw PGRST116
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("id, agent_id, brokerage_id")
      .eq("id", contactId)
      .maybeSingle()

    if (contactError || !contact) {
      return { success: false, error: "Contact not found" }
    }

    // Agent must own this contact or be in same brokerage with access
    if (contact.agent_id !== agentId) {
      // Check brokerage membership for brokers/admins
      const { data: agent } = await supabase
        .from("agents")
        .select("brokerage_id")
        .eq("id", agentId)
        .maybeSingle()

      if (!agent || agent.brokerage_id !== contact.brokerage_id) {
        return { success: false, error: "No access to this contact" }
      }
    }

    // Insert message
    const { data: message, error: insertError } = await supabase
      .from("client_portal_messages")
      .insert({
        contact_id: contactId,
        agent_id: agentId,
        brokerage_id: contact.brokerage_id,
        body: messageBody.trim(),
        direction,
        channel,
        read: false,
        transaction_id: transactionId || null,
        read_at: null,
      })
      .select()
      .maybeSingle()

    if (insertError || !message) {
      console.error("[Portal Messages] Insert error:", insertError)
      return { success: false, error: "Failed to send message" }
    }

    // Emit kernel event (non-blocking)
    processKernelEvent({
      event: KernelEvent.CLIENT_PORTAL_MESSAGE_SENT,
      entityType: "contact",
      entityId: contactId,
      brokerageId: contact.brokerage_id,
    }).catch(() => {})

    return { success: true, message }
  } catch (error) {
    return handleError(error, "sendPortalMessage")
  }
}

/**
 * Mark messages as read for a contact.
 * Direction determines which messages to mark:
 * - 'agent_to_client': marks agent's messages as read (contact opened messages page)
 * - 'client_to_agent': marks client's messages as read (agent opened messages page)
 */
export async function markMessagesRead(params: MarkReadParams): Promise<{
  success: boolean
  count?: number
  error?: string
}> {
  try {
    const { contactId, direction } = params

    const access = await requireContactAccess(contactId)
    if (!access.ok) return { success: false, error: access.error }

    const supabase = createServiceClient()

    // Update unread messages — scoped by brokerage so a contact-id collision
    // across tenants can't be exploited.
    const { data, error: updateError } = await supabase
      .from("client_portal_messages")
      .update({ read: true, read_at: new Date().toISOString() })
      .eq("contact_id", contactId)
      .eq("brokerage_id", access.brokerageId)
      .eq("direction", direction)
      .eq("read", false)
      .select("id")

    if (updateError) {
      console.error("[Portal Messages] Update error:", updateError)
      return { success: false, error: "Failed to mark messages as read" }
    }

    // Emit kernel event (non-blocking)
    processKernelEvent({
      event: KernelEvent.PORTAL_MODULE_VIEWED,
      entityType: "contact",
      entityId: contactId,
      brokerageId: access.brokerageId,
    }).catch(() => {})

    return { success: true, count: data?.length || 0 }
  } catch (error) {
    return handleError(error, "markMessagesRead")
  }
}

/**
 * Get all messages for a contact.
 * Returns messages ordered by created_at ascending (oldest first).
 */
export async function getPortalMessages(contactId: string): Promise<{
  success: boolean
  messages?: PortalMessage[]
  error?: string
}> {
  try {
    const access = await requireContactAccess(contactId)
    if (!access.ok) return { success: false, error: access.error }

    const supabase = createServiceClient()

    // Fetch messages — scoped by brokerage
    const { data: messages, error: fetchError } = await supabase
      .from("client_portal_messages")
      .select("*")
      .eq("contact_id", contactId)
      .eq("brokerage_id", access.brokerageId)
      .order("created_at", { ascending: true })

    if (fetchError) {
      console.error("[Portal Messages] Fetch error:", fetchError)
      return { success: false, error: "Failed to load messages" }
    }

    return { success: true, messages: messages || [] }
  } catch (error) {
    return handleError(error, "getPortalMessages")
  }
}

/**
 * Generate AI draft suggestion for agent.
 * Uses last 3 messages as context + transaction stage + contact first name.
 * Returns draft with compliance_approved = false.
 */
export async function generateAIDraft(params: {
  contactId: string
  transactionId?: string
  /** Optional: passed from CRM page — used for agent context but not required for draft generation */
  agentId?: string
  conversationId?: string
}): Promise<{
  success: boolean
  draft?: string
  error?: string
}> {
  try {
    const { contactId, transactionId } = params

    // Auth gate — burns paid Claude inference per call. Restricted to
    // agents/admins in the contact's brokerage (not the contact themselves,
    // who shouldn't be drafting "agent-side" replies).
    const access = await requireContactAccess(contactId)
    if (!access.ok) return { success: false, error: access.error }
    if (access.isContactSelf) {
      return { success: false, error: "Forbidden" }
    }

    const supabase = createServiceClient()

    const { data: contact } = await supabase
      .from("contacts")
      .select("first_name, contact_type, buyer_stage")
      .eq("id", contactId)
      .eq("brokerage_id", access.brokerageId)
      .maybeSingle()

    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    // Get last 3 messages for context — scoped to brokerage
    const { data: recentMessages } = await supabase
      .from("client_portal_messages")
      .select("body, direction, created_at")
      .eq("contact_id", contactId)
      .eq("brokerage_id", access.brokerageId)
      .order("created_at", { ascending: false })
      .limit(3)

    // Get transaction stage if available — verify it belongs to brokerage
    let stageContext = ""
    if (transactionId) {
      const { data: tx } = await supabase
        .from("transactions").select("brokerage_id").eq("id", transactionId).maybeSingle()
      if (tx && tx.brokerage_id === access.brokerageId) {
        const { data: milestones } = await supabase
          .from("transaction_milestones")
          .select("milestone_name, status")
          .eq("transaction_id", transactionId)
          .order("created_at", { ascending: false })
          .limit(1)

        if (milestones?.[0]) {
          stageContext = `Current transaction stage: ${milestones[0].milestone_name} (${milestones[0].status})`
        }
      }
    }

    // Build context for AI
    const conversationContext = recentMessages
      ?.reverse()
      .map((m) => `${m.direction === "agent_to_client" ? "Agent" : "Client"}: ${m.body}`)
      .join("\n")

    const contactName = contact.first_name || "there"
    const contactStage = contact.buyer_stage || contact.contact_type || "client"

    // Generate draft using AI SDK v6 via Vercel AI Gateway
    const { generateText } = await import("ai")
    const { gateway } = await import("@ai-sdk/gateway")

    const { text: draft } = await generateText({
      model: gateway("anthropic/claude-sonnet-4-5"),
      system: `You are a helpful real estate assistant drafting a professional, warm message for an agent to send to their client. 
Keep messages concise (2-3 sentences), friendly, and action-oriented.
Never include placeholder text like [AGENT NAME] - the agent will personalize.
Always address the client by their first name.
Do not include a signature line.`,
      prompt: `Draft a follow-up message to ${contactName} (${contactStage}).

${stageContext ? stageContext + "\n\n" : ""}Recent conversation:
${conversationContext || "No recent messages - this will be the first message."}

Write a brief, helpful message that moves the conversation forward. Be specific and actionable.`,
      maxOutputTokens: 400,
    })

    return {
      success: true,
      draft: draft.trim(),
    }
  } catch (error) {
    console.error("[Portal Messages] AI draft error:", error)
    return { success: false, error: "Failed to generate draft" }
  }
}

export async function shareSocialPostWithSeller(contactId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { success: false, error: "Unauthorized" }
    await sendPortalMessage({
      contactId,
      messageBody: "I'd like to share a social post with you — check your portal for the latest marketing update.",
      direction: "agent_to_client",
      channel: "portal",
    })
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Failed to share" }
  }
}
