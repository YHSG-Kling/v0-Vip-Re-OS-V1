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
// De-confliction counts touchpoints per contact for email / sms / video (and mail/phone via
// other sources). Non-outreach steps (wait / condition / task / segment ops) map to null and
// record no touchpoint. Unmapped channels are skipped rather than risking a CHECK violation.
const STEP_TO_TOUCHPOINT_CHANNEL: Record<string, string> = {
  email:        "email",
  sms:          "sms",
  video:        "video",
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

// PROVENANCE — which manager produced this touch. The send itself is the Campaign Orchestrator's
// job, but the channel's owning manager is the meaningful attribution for "why did my client get
// this?": voice is the AI ISA's, social/direct-mail are the Marketing Agent's, video is assembled
// by the Asset Manager (Video Director). Pure + defaulting (campaign_orchestrator) so it never throws.
const CHANNEL_TO_MANAGER: Record<string, string> = {
  ai_call:     "ai_isa",
  voice_drop:  "ai_isa",
  social_post: "marketing_agent",
  direct_mail: "marketing_agent",
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
  const channel = touchpointChannelForStep(input.stepChannel)
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
        manager:       touchpointManagerForChannel(input.stepChannel),
        ai_intent:     input.aiIntent ?? null,
      },
    })
    return !error
  } catch {
    return false
  }
}
