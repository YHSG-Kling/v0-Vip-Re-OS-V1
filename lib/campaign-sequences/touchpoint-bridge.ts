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

export interface RecordSequenceTouchpointInput {
  brokerageId: string
  sequenceId:  string
  contactId:   string
  enrollmentId: string
  stepId:      string
  stepChannel: string
  sentAt:      string
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
      metadata:     { enrollment_id: input.enrollmentId, step_id: input.stepId, step_channel: input.stepChannel },
    })
    return !error
  } catch {
    return false
  }
}
