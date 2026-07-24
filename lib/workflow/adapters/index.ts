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
      sender_type: "ai", // AI-authored sequence send — the unified inbox labels it
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
    const r = await initiateVoiceCall(
      { contactId: contact.id as string, initiatorRole: "ai", callType: "outbound", vendor: "twilio", agentId: agentId ?? undefined },
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

// COMMISSION VIDEO adapter — a sequence step that commissions the VIDEO DIRECTOR's full assembly
// (Remotion composition + persona hook + b-roll + tracked QR), staged for the render cron + human
// approval. Distinct from the lightweight D-ID `video` step: this is the Asset Manager's library →
// Video Director (commissionVideo) → render path. Leads have no agent → skipped (commission needs
// an agent for the QR/contact attribution). The downstream send is a later step referencing the
// staged project; commissioning is this step's deliverable (output carries the project id).
const commissionVideoAdapter: ChannelAdapter = {
  channel: "commission_video",
  async execute(ctx: StepContext): Promise<StepResult> {
    const { contact, step, brokerageId, agentUserId, entity, supabase } = ctx
    // Resolve the sender: a contact's assigned agent (solo_agent tier), or — for a LEAD / unowned
    // record — the brokerage's system user for BRAND-marketing video (brokerage tier). Videos DO go
    // out for leads; they just carry the brokerage's brand identity instead of a personal agent's.
    let senderUserId: string | null = agentUserId ?? null
    let tier: "solo_agent" | "brokerage" = "solo_agent"
    if (!senderUserId) {
      const { data: bk } = await supabase.from("brokerages").select("ai_isa_system_user_id").eq("id", brokerageId).maybeSingle()
      senderUserId = (bk as any)?.ai_isa_system_user_id ?? null
      tier = "brokerage"
    }
    if (!senderUserId) {
      return { status: "skipped", providerKey: "video-director", error: "commission_video has no sender (no agent, no brokerage system user)" }
    }
    const { commissionSituationForStep } = await import("@/lib/video/commission-situation")
    const situation = commissionSituationForStep(step as any, { contactId: contact?.id as string | undefined, tier })
    const { commissionVideo } = await import("@/lib/video/video-director")
    const r = await commissionVideo(situation as any, { brokerageId, agentUserId: senderUserId, contactId: (contact?.id as string) ?? null })
    // staged / already_staged = the Director did its job; blocked (compliance) = skip; else error.
    const status: StepResult["status"] = r.ok ? "sent" : (r.status === "blocked" ? "skipped" : "error")
    return {
      status,
      providerKey: "video-director",
      messageId: r.videoProjectId,
      error: r.ok ? undefined : (r.reason ?? (r.violations?.join("; "))),
      output: { video_project_id: r.videoProjectId ?? null, composition_id: r.compositionId ?? null, commission_status: r.status },
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
registry.register(commissionVideoAdapter)

export { registry }
