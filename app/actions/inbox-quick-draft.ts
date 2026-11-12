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

import { resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { createServiceClient } from "@/lib/supabase/service"
import {
  generateAIReplyDraftForTenant,
  type GenerateAIReplyDraftResult,
} from "@/lib/ai-reply-coach/reply-draft-core"

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
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()

  // Lane 92A: tenant-predicated. This read was by id alone on the SERVICE client, so
  // any conversation id on the platform drafted against another tenant's thread, and the
  // draft's tenant then fell back to that ROW's brokerage. The session's tenant is the one.
  const { data: convo, error: convoErr } = await svc
    .from("conversations")
    .select("id, contact_id, type")
    .eq("id", params.conversationId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  if (convoErr) return { success: false, error: `Could not read the conversation: ${convoErr.message}` }
  if (!convo) return { success: false, error: "Conversation not found in your brokerage" }

  const channel = toDraftChannel(convo.type)
  if (!channel) {
    return { success: false, error: `Reply draft not supported for channel: ${convo.type}` }
  }

  const { data: lastInbound, error: inboundErr } = await svc
    .from("messages")
    .select("id, body")
    .eq("conversation_id", convo.id)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (inboundErr) return { success: false, error: `Could not read the last inbound message: ${inboundErr.message}` }

  // The generator trusts its tenant (lib/ai-reply-coach/reply-draft-core.ts); this
  // action resolved it from the act-as write seam above, so it calls the core directly
  // rather than the public door (whose plain session read would not see an act-as).
  return generateAIReplyDraftForTenant({
    brokerageId: ctx.brokerageId,
    agentUserId: ctx.userId,
    conversationId: convo.id,
    contactId: convo.contact_id,
    inboundMessageId: lastInbound?.id ?? null,
    inboundBody: lastInbound?.body ?? "",
    channel,
  })
}
