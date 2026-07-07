"use server"

/**
 * app/actions/inbox.ts
 * Server Action wrappers for the universal inbox kernel commands.
 *
 * Pattern:
 *   1. Authenticate via createClient() (user-scoped, RLS enforced)
 *   2. Resolve brokerageId + role from DB
 *   3. Build ActorContext
 *   4. Call kernel command (lib/kernel/communications.ts)
 *   5. Return plain serializable result
 *
 * Import from this file — never from lib/kernel/communications directly in client components.
 */

import { createClient } from "@/lib/supabase/server"
import { buildActorContext } from "@/lib/kernel/actor-context"
import {
  loadUniversalInbox,
  sendInboxReply,
  type InboxChannel,
  type InboxMessageRow,
  type InboxThread,
} from "@/lib/kernel/communications"

// ─── RE-EXPORT TYPES (safe to use in client components) ───────────────────────
export type { InboxChannel, InboxMessageRow, InboxThread }

// ─── RESOLVE ACTOR CONTEXT (shared util) ─────────────────────────────────────

async function resolveActorContext() {
  const supabase = await createClient()

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser()

  if (authErr || !user) {
    throw new Error("Unauthorized")
  }

  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  // Fall back to agents table if users row has no brokerage_id
  let brokerageId = userData?.brokerage_id ?? ""
  const role = userData?.user_type ?? "agent"

  if (!brokerageId) {
    const { data: agentRow } = await supabase
      .from("agents")
      .select("brokerage_id")
      .eq("user_id", user.id)
      .maybeSingle()
    brokerageId = agentRow?.brokerage_id ?? ""
  }

  return buildActorContext({ userId: user.id, brokerageId, role })
}

// ─── ACTION: getInboxMessages ─────────────────────────────────────────────────

export interface GetInboxMessagesParams {
  channel?: InboxChannel
  contactId?: string
  unreadOnly?: boolean
  limit?: number
}

export async function getInboxMessages(params: GetInboxMessagesParams = {}): Promise<{
  success: boolean
  messages?: InboxMessageRow[]
  threads?: InboxThread[]
  totalUnread?: number
  error?: string
}> {
  try {
    const actorContext = await resolveActorContext()

    const result = await loadUniversalInbox({
      actorContext,
      channel: params.channel ?? "all",
      contactId: params.contactId,
      unreadOnly: params.unreadOnly ?? false,
      limit: params.limit ?? 50,
    })

    if (!result.success || !result.data) {
      return { success: false, error: result.error ?? "Failed to load inbox" }
    }

    return {
      success: true,
      messages: result.data.messages,
      threads: result.data.threads,
      totalUnread: result.data.totalUnread,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to load inbox",
    }
  }
}

// ─── ACTION: sendInboxMessage ─────────────────────────────────────────────────

export interface SendInboxMessageParams {
  contactId: string
  body: string
  channel: "sms" | "email" | "portal" | "chat"
}

export async function sendInboxMessage(params: SendInboxMessageParams): Promise<{
  success: boolean
  messageId?: string
  error?: string
}> {
  try {
    const actorContext = await resolveActorContext()

    const result = await sendInboxReply({
      actorContext,
      contactId: params.contactId,
      body: params.body,
      channel: params.channel,
    })

    return result
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to send message",
    }
  }
}

// ─── ACTION: forceComplianceOverrideAndSend ─────────────────────────────────
//
// Broker / admin / compliance bypass for the 6-rules compliance gate. When
// an outbound message is blocked by evaluateOutbound (brand voice, fair
// housing wording, them-first ratio, etc.), an elevated user_type can
// force-send with a written reason. Every override writes a
// compliance_events audit row.
//
// Authority: requireOverrideActor restricts to broker / broker_admin /
// admin / superadmin / compliance_officer / compliance_manager and
// enforces a minimum 10-character reason.
//
// Hard legal stops (CANNOT be overridden):
//   - dnc_status = true   (contact has explicitly opted out)
//   - tcpa_consent != true for sms/email channels
// These remain enforced because they're legal boundaries, not gating
// suggestions. The override only bypasses brand voice / them-first /
// fair-housing-wording gates.

export interface ForceComplianceOverrideParams {
  contactId:      string
  body:           string
  channel:        "sms" | "email" | "portal" | "chat"
  overrideReason: string
}

export async function forceComplianceOverrideAndSend(
  params: ForceComplianceOverrideParams,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  let overrideCtx
  try {
    const { requireOverrideActor } = await import("@/lib/kernel/portal-auth")
    overrideCtx = await requireOverrideActor(params.overrideReason)
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Override authorization failed",
    }
  }

  const supabase = await createClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone, brokerage_id, agent_id, dnc_status, tcpa_consent")
    .eq("id", params.contactId)
    .eq("brokerage_id", overrideCtx.brokerageId)
    .maybeSingle()

  if (!contact) {
    return { success: false, error: "Contact not found in your brokerage" }
  }

  if (contact.dnc_status === true) {
    return {
      success: false,
      error: "Cannot override DNC — contact has explicitly opted out. This is a legal boundary, not a compliance suggestion.",
    }
  }
  if ((params.channel === "sms" || params.channel === "email") && contact.tcpa_consent !== true) {
    return {
      success: false,
      error: `Cannot override TCPA — contact has not consented to ${params.channel.toUpperCase()} contact.`,
    }
  }

  // Capture the original violations for the audit row
  let originalViolations: string[] = []
  let originalBlockedReason: string | null = null
  try {
    const { evaluateOutbound } = await import("@/lib/kernel/compliance")
    const messageType =
      params.channel === "sms" ? "sms" :
      params.channel === "email" ? "email" : "in_app"
    const result = await evaluateOutbound({
      actorContext: {
        userId:      overrideCtx.userId,
        brokerageId: overrideCtx.brokerageId,
        role:        overrideCtx.userType as never,
      },
      journeyType: "buyer",
      persona:     "other",
      messageType: messageType as never,
      content:     params.body,
      contact:     contact as never,
    })
    originalViolations    = result.violations ?? []
    originalBlockedReason = result.blockedReason ?? null
  } catch {
    // non-fatal — write the audit row with what we have
  }

  // Audit row: allowed=false because the original gate failed, with the
  // OVERRIDE_REASON appended to violations + OVERRIDDEN prefix on
  // blocked_reason so compliance reports can filter for these.
  await supabase
    .from("compliance_events")
    .insert({
      brokerage_id:   overrideCtx.brokerageId,
      actor_user_id:  overrideCtx.userId,
      actor_role:     overrideCtx.userType,
      entity_type:    "contact",
      entity_id:      params.contactId,
      message_type:   params.channel,
      gate_name:      "evaluateOutbound",
      allowed:        false,
      violations:     [
        ...originalViolations,
        `OVERRIDE_REASON: ${overrideCtx.reason}`,
      ],
      blocked_reason: originalBlockedReason
        ? `OVERRIDDEN: ${originalBlockedReason}`
        : `OVERRIDDEN by ${overrideCtx.userType}`,
    })
    .then(() => null, () => null)

  // Resolve agent_id for the insert (mirrors sendInboxReply)
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", overrideCtx.userId)
    .eq("brokerage_id", overrideCtx.brokerageId)
    .maybeSingle()
  const agentId = agentRow?.id ?? null

  const now = new Date().toISOString()
  if (params.channel === "portal" || params.channel === "chat") {
    const { data: msg, error } = await supabase
      .from("client_portal_messages")
      .insert({
        contact_id:   params.contactId,
        agent_id:     contact.agent_id ?? agentId,
        brokerage_id: overrideCtx.brokerageId,
        direction:    "agent_to_client",
        channel:      "portal",
        body:         params.body,
        read:         false,
        read_at:      null,
        created_at:   now,
        metadata:     { compliance_override: true, override_actor: overrideCtx.userId },
      })
      .select("id")
      .maybeSingle()
    if (error || !msg) {
      return { success: false, error: error?.message ?? "Failed to insert message" }
    }
    return { success: true, messageId: msg.id }
  }

  // sms / email path — messages table. conversation_id is NOT NULL (live
  // schema): resolve the thread first via the ONE canonical helper.
  const { ensureConversationForContact } = await import("@/lib/kernel/conversation-thread")
  const conversationId = await ensureConversationForContact(supabase, {
    contactId: params.contactId, brokerageId: overrideCtx.brokerageId, agentId,
  })
  if (!conversationId) return { success: false, error: "Could not resolve the conversation thread" }
  const { data: msg, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      contact_id:      params.contactId,
      agent_id:        agentId,
      brokerage_id:    overrideCtx.brokerageId,
      type:            params.channel,
      direction:       "outbound",
      body:            params.body,
      status:          "sent",
      created_at:      now,
      updated_at:      now,
    })
    .select("id")
    .maybeSingle()
  if (error || !msg) {
    return { success: false, error: error?.message ?? "Failed to insert message" }
  }
  return { success: true, messageId: msg.id }
}

// ─── ACTION: markInboxRead ────────────────────────────────────────────────────

export async function markInboxRead(params: {
  contactId: string
  channel?: string
}): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { success: false, error: "Unauthorized" }

    // Resolve caller's brokerage_id — previous code authed the caller but
    // then mutated by contact_id only, letting anyone mark another tenant's
    // messages read.
    const { data: callerRow } = await supabase
      .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
    if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }

    // Verify the contact belongs to the caller's brokerage
    const { data: contact } = await supabase
      .from("contacts").select("brokerage_id").eq("id", params.contactId).maybeSingle()
    if (!contact || contact.brokerage_id !== callerRow.brokerage_id) {
      return { success: false, error: "Forbidden" }
    }

    // Mark portal messages as read — scoped by brokerage
    await supabase
      .from("client_portal_messages")
      .update({ read: true, read_at: new Date().toISOString() })
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", callerRow.brokerage_id)
      .eq("read", false)

    // Mark messages table — scoped by brokerage
    await supabase
      .from("messages")
      .update({ status: "read" })
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", callerRow.brokerage_id)
      .eq("status", "unread")

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to mark read",
    }
  }
}
