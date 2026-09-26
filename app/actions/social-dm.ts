"use server"

/**
 * Social DM reply action — the outbound half of the unified inbox's social lane.
 *
 * Why not sendMessage(): social DM threads created by the meta-dm webhook are
 * often contact-LESS (a stranger DM'd the page) — sendMessage requires a
 * verified contact. This action resolves the send lane from the THREAD:
 *
 *   Meta lane     — conversations.context_data {page_id, sender_id, platform}
 *                   (captured at ingestion) + the tenant's connected page token.
 *   WhatsApp lane — the thread's contact carries metadata.whatsapp_id; the
 *                   tenant's connected WhatsApp Business number sends.
 *
 * Reply-only posture: we only answer threads the person started (Meta
 * messaging_type RESPONSE; WhatsApp free-form inside the customer window) —
 * consent context is inherent to an inbound DM. A failed dispatch NEVER
 * writes a fake "sent" row; the composer shows the honest reason.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchSocialDm, socialDmSupport, type SocialDmPlatform } from "@/lib/social/dm-dispatch"
import { revalidatePath } from "next/cache"

export interface SendSocialDmReplyResult {
  success: boolean
  message?: any
  error?: string
  /** Platform can never send (LinkedIn/X) — composer should stay log-only. */
  unsupported?: boolean
}

export async function sendSocialDmReply(params: {
  conversationId: string
  body: string
}): Promise<SendSocialDmReplyResult> {
  try {
    const text = (params.body ?? "").trim()
    if (!text) return { success: false, error: "Message is empty" }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { success: false, error: "Unauthorized" }
    const { data: u } = await supabase
      .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
    if (!u?.brokerage_id) return { success: false, error: "Unauthorized" }
    const brokerageId = u.brokerage_id as string
    const { data: agentRow } = await supabase
      .from("agents").select("id").eq("user_id", user.id).maybeSingle()
    const agentId = (agentRow?.id as string | undefined) ?? null

    const svc = createServiceClient()

    // ── Thread + tenant check ────────────────────────────────────────────────
    const { data: convo } = await svc
      .from("conversations")
      .select("id, brokerage_id, agent_id, contact_id, type, context_data, message_count")
      .eq("id", params.conversationId)
      .maybeSingle()
    if (!convo) return { success: false, error: "Conversation not found" }
    if (convo.brokerage_id !== brokerageId) return { success: false, error: "Forbidden" }
    const convoType = String(convo.type ?? "")
    if (!convoType.toLowerCase().startsWith("social")) {
      return { success: false, error: "Not a social thread" }
    }

    // ── Resolve the send lane ────────────────────────────────────────────────
    const ctx = (convo.context_data ?? {}) as Record<string, any>
    let platform: SocialDmPlatform | null = null
    let accountId: string | null = null
    let accessToken: string | null = null
    let recipientId: string | null = null

    if (ctx.page_id && ctx.sender_id) {
      // Meta lane — the webhook stamped the receiving page + the sender's PSID/IGSID.
      platform = (ctx.platform === "instagram" ? "instagram" : "facebook")
      recipientId = String(ctx.sender_id)
      const { data: account } = await svc
        .from("social_media_accounts")
        .select("account_id, access_token")
        .eq("brokerage_id", brokerageId)
        .eq("account_id", String(ctx.page_id))
        .eq("is_active", true)
        .limit(1)
        .maybeSingle()
      accountId = (account?.account_id as string | undefined) ?? null
      accessToken = (account?.access_token as string | undefined) ?? null
      if (!accountId || !accessToken) {
        return { success: false, error: `The ${platform === "instagram" ? "Instagram" : "Facebook"} account behind this thread isn't connected anymore — reconnect it in Settings → Social.` }
      }
    } else {
      // Channel-suffixed spine threads (social_dm_whatsapp / _linkedin / _twitter)
      // or derive from context platform.
      const suffix = convoType.toLowerCase().replace(/^social_dm_?/, "").replace(/^social_?/, "")
      const derived = (ctx.platform ?? suffix) as string
      if (derived === "whatsapp") {
        platform = "whatsapp"
        // Recipient: the thread's contact's WhatsApp id (stamped at ingestion).
        if (convo.contact_id) {
          const { data: contact } = await svc
            .from("contacts").select("metadata, phone")
            .eq("id", convo.contact_id).eq("brokerage_id", brokerageId).maybeSingle()
          const waId = (contact?.metadata as any)?.whatsapp_id as string | undefined
          recipientId = waId ?? (contact?.phone ? String(contact.phone).replace(/\D/g, "") : null)
        }
        if (!recipientId) {
          return { success: false, error: "No WhatsApp identity on this thread's contact — replies are only possible on threads the contact started." }
        }
        const { data: waAccount } = await svc
          .from("social_media_accounts")
          .select("account_id, access_token")
          .eq("brokerage_id", brokerageId)
          .eq("platform", "whatsapp")
          .eq("is_active", true)
          .limit(1)
          .maybeSingle()
        accountId = (waAccount?.account_id as string | undefined) ?? null
        accessToken = (waAccount?.access_token as string | undefined) ?? null
        if (!accountId || !accessToken) {
          return { success: false, error: "No connected WhatsApp Business account — connect one in Settings → Social." }
        }
      } else {
        // LinkedIn / X / unknown — honest unsupported (composer stays log-only).
        const support = socialDmSupport(derived)
        return { success: false, unsupported: true, error: support.reason ?? "This platform has no DM send path." }
      }
    }

    // ── Dispatch through the connected account ───────────────────────────────
    const result = await dispatchSocialDm({
      platform: platform!,
      accountId: accountId!,
      accessToken: accessToken!,
      recipientId: recipientId!,
      text,
    })
    if (!result.success) {
      // NEVER a fake sent row — the composer shows the honest platform reason.
      return { success: false, error: result.error, unsupported: result.unsupported }
    }

    // ── Persist the sent reply on the thread ─────────────────────────────────
    const nowIso = new Date().toISOString()
    const { data: message } = await svc
      .from("messages")
      .insert({
        conversation_id: convo.id,
        contact_id: convo.contact_id ?? null,
        brokerage_id: brokerageId,
        agent_id: agentId ?? convo.agent_id ?? null,
        type: convoType, // stay consistent with the thread's inbound rows
        direction: "outbound",
        sender_type: "agent",
        body: text,
        status: "sent",
        metadata: { platform, provider_message_id: result.providerMessageId ?? null },
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select()
      .single()

    await svc
      .from("conversations")
      .update({
        last_message_at: nowIso,
        updated_at: nowIso,
        message_count: (Number(convo.message_count) || 0) + 1,
      })
      .eq("id", convo.id)

    // Provider log — same rail every other channel writes (fire-and-forget).
    ;(async () => {
      try {
        await svc.from("message_provider_logs").insert({
          brokerage_id: brokerageId,
          message_id: message?.id ?? null,
          provider_key: platform,
          // message_provider_logs.channel says 'ai_social_dm'.
          channel: "ai_social_dm",
          direction: "outbound",
          provider_message_id: result.providerMessageId ?? null,
          provider_status: "sent",
        })
      } catch { /* logging never blocks the send */ }
    })()

    revalidatePath("/dashboard/communications/inbox")
    return { success: true, message }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to send DM" }
  }
}
