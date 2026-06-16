/**
 * lib/workflow/adapters/index.ts
 *
 * Registers all channel adapters into the singleton registry.
 * Import this once at executor startup — all registrations happen as a side effect.
 */

import { registry } from "../channel-registry"

import { emailAdapter }             from "./email"
import { smsAdapter }               from "./sms"
import { voiceDropAdapter }         from "./voice-drop"
import { waitAdapter }              from "./wait"
import { conditionAdapter }         from "./condition"
import { directMailAdapter }        from "./direct-mail"
import { videoAdapter }             from "./video"
import { aiImageAdapter }           from "./ai-image"
import { socialPostAdapter }        from "./social-post"
import { newsletterAdapter }        from "./newsletter"
import { assignTaskAdapter }        from "./assign-task"
import { draftDocumentAdapter }     from "./draft-document"
import { scheduleShowingAdapter }   from "./schedule-showing"
import { scheduleTourAdapter }      from "./schedule-tour"
import { avmCmaAdapter }            from "./avm-cma"
import { adCampaignAdapter }        from "./ad-campaign"
import { listingLandingPageAdapter } from "./listing-landing-page"
import { sendForEsignAdapter }       from "./send-for-esign"
import { sendGiftAdapter }           from "./send-gift"
import { addToSegmentAdapter, removeFromCampaignAdapter } from "./segment-ops"

// In-app message adapter (inline — simple enough to not need its own file)
import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

const inAppAdapter: ChannelAdapter = {
  channel: "in_app",
  async execute(ctx: StepContext): Promise<StepResult> {
    const { contact, step, brokerageId, agentId, agentUserId, supabase } = ctx

    if (!contact?.id) {
      return { status: "error", providerKey: "in_app", error: "No contact" }
    }

    let resolvedAgentId = agentId
    if (!resolvedAgentId && agentUserId) {
      const { data: a } = await supabase
        .from("agents").select("id")
        .eq("user_id", agentUserId).eq("brokerage_id", brokerageId).maybeSingle()
      resolvedAgentId = a?.id ?? null
    }

    if (!resolvedAgentId) {
      return { status: "error", providerKey: "in_app", error: "No agent record for in_app message" }
    }

    const { data: convRow } = await supabase
      .from("conversations")
      .upsert(
        { contact_id: contact.id, agent_id: resolvedAgentId, brokerage_id: brokerageId, status: "active", updated_at: new Date().toISOString() },
        { onConflict: "contact_id,agent_id" }
      )
      .select("id").single()

    if (!convRow?.id) {
      return { status: "error", providerKey: "in_app", error: "Could not resolve conversation" }
    }

    const { data: msgRow } = await supabase.from("messages").insert({
      conversation_id: convRow.id,
      contact_id: contact.id,
      agent_id: resolvedAgentId,
      brokerage_id: brokerageId,  // for superadmin billing rollups
      type: "in_app",
      direction: "outbound",
      body: step.body ?? "",
      status: "sent",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).select("id").single()

    return {
      status: msgRow ? "sent" : "error",
      providerKey: "in_app",
      messageId: msgRow?.id,
      error: msgRow ? undefined : "messages insert failed",
    }
  },
}

// AI Call adapter — places a real outbound AI voice call as a sequence step via the voice engine.
// The voice agent uses the existing voice-verb tool-registry DURING the call; this adapter only
// INITIATES it. initiateVoiceCall is provider-gated (clean failure if VAPI/Twilio unconfigured) and
// enforces call_stop_flag + DNC before any vendor call. The executor's TCPA gate + lead-only gate
// already screen ai_call upstream (consent required; leads never reach voice) — defence in depth.
const aiCallAdapter: ChannelAdapter = {
  channel: "ai_call",
  async execute(ctx: StepContext): Promise<StepResult> {
    const { contact, agentId, entity } = ctx
    if (entity === "lead") {
      return { status: "skipped", providerKey: "ai_call", error: "ai_call not permitted for unconsented leads (email/direct-mail only)" }
    }
    if (!contact?.id || !contact?.phone) {
      return { status: "error", providerKey: "ai_call", error: "No contact phone for ai_call" }
    }
    const { initiateVoiceCall } = await import("@/lib/voice-engine/call-executor")
    const vendor = process.env.VAPI_API_KEY ? "vapi_isa" : "twilio"
    const r = await initiateVoiceCall(
      { contactId: contact.id as string, initiatorRole: "ai", callType: "outbound", vendor, agentId: agentId ?? undefined },
      contact.phone as string,
    )
    return {
      status: r.success ? "sent" : "error",
      providerKey: "ai_call",
      messageId: r.vendorCallId ?? r.callId,
      error: r.error,
    }
  },
}

// ─── Register all adapters ────────────────────────────────────────────────────

registry.register(emailAdapter)
registry.register(smsAdapter)
registry.register(voiceDropAdapter)
registry.register(waitAdapter)
registry.register(conditionAdapter)
registry.register(directMailAdapter)
registry.register(videoAdapter)
registry.register(aiImageAdapter)
registry.register(socialPostAdapter)
registry.register(newsletterAdapter)
registry.register(assignTaskAdapter)
registry.register(draftDocumentAdapter)
registry.register(scheduleShowingAdapter)
registry.register(scheduleTourAdapter)
registry.register(avmCmaAdapter)
registry.register(adCampaignAdapter)
registry.register(listingLandingPageAdapter)
registry.register(sendForEsignAdapter)
registry.register(sendGiftAdapter)
registry.register(addToSegmentAdapter)
registry.register(removeFromCampaignAdapter)
registry.register(inAppAdapter)
registry.register(aiCallAdapter)

export { registry }
