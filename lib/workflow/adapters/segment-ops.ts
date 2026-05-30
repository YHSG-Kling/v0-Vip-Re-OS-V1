/**
 * Segment operation adapters — add_to_segment and remove_from_campaign.
 * These are control-flow steps, not message dispatches.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const addToSegmentAdapter: ChannelAdapter = {
  channel: "add_to_segment",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, contact, brokerageId, supabase } = ctx

    if (!contact?.id || !step.body) {
      return { status: "skipped", providerKey: "segment", error: "No contact or segment ID" }
    }

    const segmentId = step.body // body holds the segment_id for this step type

    await supabase.from("contact_segments").upsert({
      contact_id: contact.id,
      segment_id: segmentId,
      brokerage_id: brokerageId,
      added_at: new Date().toISOString(),
    }, { onConflict: "contact_id,segment_id" })

    return { status: "sent", providerKey: "segment", output: { segment_id: segmentId } }
  },
}

export const removeFromCampaignAdapter: ChannelAdapter = {
  channel: "remove_from_campaign",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, contact, supabase } = ctx

    if (!contact?.id) {
      return { status: "skipped", providerKey: "campaign", error: "No contact" }
    }

    const targetSequenceId = step.body // body holds the sequence_id to unenroll from

    if (targetSequenceId) {
      await supabase
        .from("sequence_enrollments")
        .update({ status: "cancelled", completed_at: new Date().toISOString() })
        .eq("contact_id", contact.id)
        .eq("sequence_id", targetSequenceId)
        .eq("status", "active")
    }

    return { status: "sent", providerKey: "campaign" }
  },
}
