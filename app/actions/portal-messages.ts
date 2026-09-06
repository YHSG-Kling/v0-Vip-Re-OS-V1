"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import { handleError } from "@/lib/errors"
import { requireContactAccess } from "@/lib/portal/require-contact-access"

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

    const { contactId, messageBody, direction: requestedDirection, channel = "portal", transactionId } = params
    let direction = requestedDirection
    let isClientSender = false

    // Validate message body
    if (!messageBody || messageBody.trim().length === 0) {
      return { success: false, error: "Message body cannot be empty" }
    }
    if (messageBody.length > 2000) {
      return { success: false, error: "Message body cannot exceed 2000 characters" }
    }

    // Resolve agent identity (never use user.id for agent_id column)
    const callerAgentId = await resolveAgentId(supabase, user.id)

    // Read the contact with the service client — maybeSingle() so missing rows
    // don't throw PGRST116. Deliberately not the anon client: a portal CLIENT
    // may not be able to read their own contacts row under RLS, and an
    // unreadable row here would report "Contact not found" for the person the
    // row is about. Nothing is returned to the caller from this read; the two
    // branches below are what decide access.
    const { data: contact, error: contactError } = await createServiceClient()
      .from("contacts")
      .select("id, agent_id, brokerage_id")
      .eq("id", contactId)
      .maybeSingle()

    if (contactError || !contact) {
      return { success: false, error: "Contact not found" }
    }

    // client_portal_messages.agent_id names the agent on the THREAD, not the
    // sender — one column carries both directions. Which agent that is depends
    // on who is calling.
    let agentId: string

    if (callerAgentId) {
      // ── Agent / staff lane (unchanged) ──
      agentId = callerAgentId
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
    } else {
      // ── Buyer / seller lane ──
      //
      // This branch did not exist: the function resolved the caller as an agent
      // and returned "Agent profile not found" otherwise. A client signed into
      // the consumer portal has no `agents` row, so the ONE direction the portal
      // exists for — client_to_agent — could never be sent. The portal's
      // "Contact Agent" control looked wired and refused every time.
      //
      // The thread's agent is RESOLVED from contacts.agent_id, which is already
      // an agents.id. It is never the caller's user id.
      const access = await requireContactAccess(contactId)
      if (!access.ok || !access.isContactSelf) {
        return { success: false, error: "No access to this contact" }
      }
      if (!contact.agent_id) {
        return { success: false, error: "No agent is assigned to this account yet" }
      }
      agentId = contact.agent_id
      // A client cannot post as their agent, whatever the caller asked for.
      direction = "client_to_agent"
      isClientSender = true
    }

    // The RLS policy on client_portal_messages checks
    // `brokerage_id = current_user_brokerage_id()`, which reads
    // users.brokerage_id for auth.uid(). A portal client's users row is not
    // guaranteed to carry the brokerage, so the anon-key client would fail the
    // WITH CHECK for a message we have ALREADY authorized. Authorization for
    // this lane is established above by requireContactAccess against the
    // service client, so the write goes through the service client too —
    // deliberately, and only after that check.
    const writeClient = isClientSender ? createServiceClient() : supabase

    // Insert message
    const { data: message, error: insertError } = await writeClient
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

    // PUSH THE IN-APP NOTIFICATION. Writing the thread row is only half of
    // "send" — the portal's bell counts `notifications` rows by contact_id
    // (app/portal/[contactId]/layout.tsx), and nothing here created one. So an
    // agent posted a message, the OS reported success, and the client had no
    // signal it existed: they would only find it by opening Messages on a hunch.
    // A message nobody is told about is not a message.
    //
    // Notify the RECIPIENT, not the sender — agent_to_client lights the client's
    // portal bell (contact_id), client_to_agent lights the agent's (user_id).
    const notifyingClient = direction === "agent_to_client"
    let recipientUserId: string | null = null
    if (!notifyingClient) {
      const { data: agentRow } = await writeClient
        .from("agents")
        .select("user_id")
        .eq("id", agentId)
        .maybeSingle()
      recipientUserId = (agentRow?.user_id as string | null) ?? null
    }

    if (notifyingClient || recipientUserId) {
      const preview = messageBody.trim().slice(0, 140)
      const { error: notifyError } = await writeClient.from("notifications").insert({
        brokerage_id: contact.brokerage_id,
        // Exactly one recipient key is set: the contact for a client-bound
        // message, the agent's users id for an agent-bound one.
        contact_id: notifyingClient ? contactId : null,
        user_id: notifyingClient ? null : recipientUserId,
        type: "portal_message",
        // "in_app" is in the live notifications.channel CHECK
        // {email, in_app, sms} — this is the in-app lane, not an egress.
        channel: "in_app",
        title: notifyingClient ? "New message from your agent" : "New message from your client",
        body: preview,
        priority: "medium",
        entity_type: "contact",
        entity_id: contactId,
        is_read: false,
      })
      if (notifyError) {
        // The message IS in the thread; say the bell failed rather than
        // claiming the whole send failed.
        console.error("[Portal Messages] message stored but notification NOT created:", notifyError.message)
      }
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
 *
 * ─── TOMBSTONE (orphan doctrine §1.1, lane BT 2026-08-27) ───────────────────
 * app/api/portal/messages/read/route.ts DELETED. It was a 1:1 HTTP wrapper
 * around THIS action with ZERO callers: no mention of
 * "/api/portal/messages/read" anywhere in first-party source (comment-stripped,
 * positive-controlled finder), and no secret/webhook/cron lane. SURVIVOR: this
 * function, wired directly at app/portal/[contactId]/messages/page.tsx:128.
 * The sibling routes /api/portal/messages/send and
 * /api/portal/messages/[contactId] ARE referenced and are untouched.
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
