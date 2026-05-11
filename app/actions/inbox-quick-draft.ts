"use server"

/**
 * Inbox Quick-Draft — thin wrapper that resolves the agent's write context
 * server-side so the Unified Inbox slide-out can call AI-draft without
 * passing brokerageId / agentUserId from the client.
 *
 * Pairs with the `A` keyboard verb in <UnifiedInboxSlideOut>. Loads the
 * most-recent inbound message for the conversation and seeds the draft
 * generator with it.
 */

import { resolveWriteContext } from "@/lib/kernel/identity"
import { createServiceClient } from "@/lib/supabase/service"
import {
  generateAIReplyDraft,
  type GenerateAIReplyDraftResult,
} from "./ai-reply-coach"

export interface QuickDraftParams {
  conversationId: string
}

type DraftChannel = "email" | "sms" | "in_app"

function toDraftChannel(raw: string | null | undefined): DraftChannel | null {
  const k = (raw ?? "").toLowerCase()
  if (k === "email") return "email"
  if (k === "sms") return "sms"
  if (k === "in_app" || k === "portal" || k === "chat") return "in_app"
  return null
}

export async function quickDraftForConversation(
  params: QuickDraftParams,
): Promise<GenerateAIReplyDraftResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()

  const { data: convo, error: convoErr } = await svc
    .from("conversations")
    .select("id, contact_id, type, brokerage_id")
    .eq("id", params.conversationId)
    .maybeSingle()

  if (convoErr || !convo) {
    return { success: false, error: convoErr?.message ?? "Conversation not found" }
  }

  const channel = toDraftChannel(convo.type)
  if (!channel) {
    return { success: false, error: `Reply draft not supported for channel: ${convo.type}` }
  }

  const { data: lastInbound } = await svc
    .from("messages")
    .select("id, body")
    .eq("conversation_id", convo.id)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  return generateAIReplyDraft({
    brokerageId: convo.brokerage_id ?? ctx.brokerageId,
    agentUserId: ctx.userId,
    conversationId: convo.id,
    contactId: convo.contact_id,
    inboundMessageId: lastInbound?.id ?? null,
    inboundBody: lastInbound?.body ?? "",
    channel,
  })
}
