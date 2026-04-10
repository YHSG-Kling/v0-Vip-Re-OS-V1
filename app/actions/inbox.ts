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

    // Mark portal messages as read
    await supabase
      .from("client_portal_messages")
      .update({ read: true, read_at: new Date().toISOString() })
      .eq("contact_id", params.contactId)
      .eq("read", false)

    // Mark messages table
    await supabase
      .from("messages")
      .update({ status: "read" })
      .eq("contact_id", params.contactId)
      .eq("status", "unread")

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to mark read",
    }
  }
}
