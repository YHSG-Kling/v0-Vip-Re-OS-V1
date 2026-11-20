// lib/campaign-sequences/touchpoint-bridge.ts
//
// THE SHARED TOUCH LEDGER — System A (the canonical sequence engine) records every send into
// marketing_campaign_touchpoints, the SAME ledger that de-confliction, attribution, and the
// team-query bullpen already read. Until now ONLY System B (marketing triggers) wrote
// touchpoints, so the canonical drip engine's sends were INVISIBLE to the over-messaging
// frequency cap (deconflict/index.ts counts marketing_campaign_touchpoints by contact+channel).
// That is the opposite of the "one egress that knows what every lane did" promise — this closes
// it. It is also the precondition that makes System B's enrollment path retireable without
// breaking de-confliction / attribution / team-query.
//
// A sequence send has no marketing_campaign, so the row carries sequence_id (m1098 made
// campaign_id nullable + added sequence_id + source='sequence').

import type { SupabaseClient } from "@supabase/supabase-js"

// Map a sequence step.channel → the marketing_campaign_touchpoints.channel vocabulary.
// De-confliction counts touchpoints per contact for email / sms (and mail/phone via other
// sources). Non-outreach steps (wait / condition / task / segment ops) map to null and
// record no touchpoint. Unmapped channels are skipped rather than risking a CHECK violation.
//
// WAVE 155 (lane 155J — owner R9 "video is an artifact not a channel"; carries lane 155D
// Outside-lane 2, corrected): a `video` STEP makes an ARTIFACT. It is not in this map. Its
// adapter (lib/workflow/adapters/video.ts) DELIVERS the video by email through dispatchVideo,
// which already spends the contact's EMAIL allowance at the de-confliction gate
// (lib/providers/dispatch.ts — channel "email"). Deleting the old `video: "video"` row alone
// would have dropped that real email touch from the ledger de-confliction reads; recording it as
// "video" counted a lane no cap reads. So the touch is recorded ONCE, on its DELIVERING channel
// (email), stamped metadata.artifact = "video" — and only when the Contact had an email to be
// delivered to (a render with no recipient touched nobody). See deliveringChannelForStep.
const STEP_TO_TOUCHPOINT_CHANNEL: Record<string, string> = {
  email:        "email",
  sms:          "sms",
  voice_drop:   "phone",
  ai_call:      "phone",
  direct_mail:  "direct_mail",
  social_post:  "social",
  newsletter:   "newsletter",
}

/** Pure: the touchpoint channel for a sequence step, or null when the step records no touch. */
export function touchpointChannelForStep(stepChannel: string): string | null {
  return STEP_TO_TOUCHPOINT_CHANNEL[stepChannel] ?? null
}

/** The sequence steps that produce an ARTIFACT delivered on another channel (R9): step → the channel its adapter delivers on. */
const ARTIFACT_STEP_DELIVERY: Record<string, { artifact: string; channel: string }> = {
  video: { artifact: "video", channel: "email" },
}

/**
 * Pure: where an ARTIFACT step's touch is recorded — its delivering channel, and only when it was actually delivered
 * (`delivered` = the Contact had an address on that channel). null for a non-artifact step or an undelivered render.
 */
export function deliveringChannelForStep(stepChannel: string, delivered: boolean): { channel: string; artifact: string } | null {
  const a = ARTIFACT_STEP_DELIVERY[stepChannel]
  return a && delivered ? { channel: a.channel, artifact: a.artifact } : null
}

// PROVENANCE — which manager produced this touch. The send itself is the Campaign Orchestrator's
// job, and so is the channel's owning manager for "why did my client get this?" on social/direct-mail
// /blog/podcast (m618: survivor of the retired marketing_agent seat — kept as EXPLICIT map entries
// rather than deleted-to-fall-through-to-the-default, so the channel-to-manager reasoning stays
// documented even though the value now matches the default): voice is the AI ISA's, video is
// assembled by the Asset Manager (Video Director). Pure + defaulting (campaign_orchestrator) so it never throws.
// The map covers BOTH channel vocabularies that reach it (§6 — one function, one
// home): the sequence engine's step channels (ai_call, voice_drop, social_post …)
// and the campaign recorder's channel names (social, blog, podcast …), which are
// the same ideas under different spellings. Merging them here rather than adding a
// second map is what keeps a touch credited to the same manager whichever writer
// records it.
//
// DELIBERATELY UNMAPPED, so they take the campaign_orchestrator default rather than
// a wrong owner: `phone` (the recorder's human-dialed call — crediting the AI ISA
// for an agent's own call would be a false receipt; the ISA's calls arrive as
// ai_call/voice_drop), and `qr_scan`/`portal` (inbound visitor actions, not a touch
// any manager sent).
const CHANNEL_TO_MANAGER: Record<string, string> = {
  ai_call:     "ai_isa",
  voice_drop:  "ai_isa",
  social_post: "campaign_orchestrator",
  social:      "campaign_orchestrator",
  direct_mail: "campaign_orchestrator",
  blog:        "campaign_orchestrator",
  podcast:     "campaign_orchestrator",
  video:       "asset_manager",
  newsletter:  "campaign_orchestrator",
  email:       "campaign_orchestrator",
  sms:         "campaign_orchestrator",
}

/** Pure: the manager credited with a touch on this channel (defaults to campaign_orchestrator). */
export function touchpointManagerForChannel(stepChannel: string): string {
  return CHANNEL_TO_MANAGER[stepChannel] ?? "campaign_orchestrator"
}

export interface RecordSequenceTouchpointInput {
  brokerageId: string
  sequenceId:  string
  contactId:   string
  enrollmentId: string
  stepId:      string
  stepChannel: string
  sentAt:      string
  /** PROVENANCE: the intent that GENERATED this touch's copy (step.ai_intent), for "why this?". */
  aiIntent?:   string | null
}

/**
 * Record a sequence send into the shared touch ledger. Best-effort — NEVER throws and never
 * fails a send; the touchpoint is an audit/coordination signal, not the send itself. Returns
 * whether a row was written (false when the channel doesn't map to a touchpoint).
 */
export async function recordSequenceTouchpoint(
  supabase: SupabaseClient,
  input: RecordSequenceTouchpointInput,
): Promise<boolean> {
  let channel = touchpointChannelForStep(input.stepChannel)
  let artifact: string | null = null
  if (!channel && ARTIFACT_STEP_DELIVERY[input.stepChannel]) {
    // The adapter delivers only to a Contact with an email; read it under THIS tenant (a refused read records nothing —
    // an unknown delivery is never written as a touch).
    try {
      const { data, error } = await supabase.from("contacts").select("email").eq("id", input.contactId).eq("brokerage_id", input.brokerageId).maybeSingle()
      const d = error ? null : deliveringChannelForStep(input.stepChannel, !!String((data as { email?: string | null } | null)?.email ?? "").trim())
      if (d) { channel = d.channel; artifact = d.artifact }
    } catch { /* best-effort ledger: no row */ }
  }
  if (!channel) return false
  try {
    const { error } = await supabase.from("marketing_campaign_touchpoints").insert({
      brokerage_id: input.brokerageId,
      sequence_id:  input.sequenceId,
      contact_id:   input.contactId,
      channel,
      status:       "sent",
      sent_at:      input.sentAt,
      source:       "sequence",
      // Provenance — manager + sequence + ai_intent + channel make every touch answerable in the
      // Command Center: "why did my client get this, and which manager produced it?".
      // The TYPED sequence_id/source columns above are the preferred home and are read by
      // lib/intelligence/manager-touch-provenance.ts (per-manager sequence receipts) and
      // lib/intelligence/decision-receipts.ts (per-contact "sent via sequence step" trail);
      // this metadata duplicates enrollment/step linkage only for per-step drill-down.
      metadata:     {
        enrollment_id: input.enrollmentId,
        step_id:       input.stepId,
        step_channel:  input.stepChannel,
        // R9: the artifact the delivering channel carried (null for a plain email / sms step).
        artifact,
        manager:       touchpointManagerForChannel(input.stepChannel),
        ai_intent:     input.aiIntent ?? null,
      },
    })
    return !error
  } catch {
    return false
  }
}
