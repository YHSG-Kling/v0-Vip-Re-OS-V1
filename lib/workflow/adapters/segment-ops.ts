/**
 * Segment operation adapters — add_to_segment and remove_from_campaign.
 * These are control-flow steps, not message dispatches.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"
import { unenrollContact } from "@/lib/campaign-sequences/enrollment-engine"

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
    const { step, contact, brokerageId } = ctx

    if (!contact?.id) {
      return { status: "skipped", providerKey: "campaign", error: "No contact" }
    }

    const targetSequenceId = step.body // body holds the sequence_id to unenroll from

    if (!targetSequenceId) {
      // Said out loud rather than reported as a successful removal. The old
      // code fell through to `{ status: "sent" }` with no sequence named, so a
      // misconfigured step logged as having removed someone from something.
      return { status: "skipped", providerKey: "campaign", error: "No target sequence on the step" }
    }

    // TOMBSTONE — the hand-rolled UPDATE that stood here is DELETED. Survivor:
    // lib/campaign-sequences/enrollment-engine.ts:240 `unenrollContact`, the
    // engine that owns this table, which this adapter now calls. The copy wrote
    // `status: 'cancelled'` against the engine's `'unenrolled'` (§6: one
    // terminal state, two spellings, uncountable in one query), matched only
    // `active` so a PAUSED enrollment survived the removal step, carried NO
    // tenant predicate on a service-role client, and discarded the result — so
    // a refusal and a removal looked identical. All four are fixed at the
    // survivor; see the note there.
    const result = await unenrollContact({
      sequenceId: targetSequenceId,
      contactId: contact.id,
      brokerageId,
    })

    if (!result.success) {
      return { status: "failed", providerKey: "campaign", error: result.error }
    }

    return {
      status: "sent",
      providerKey: "campaign",
      // The reason this step ran lands HERE — the executor persists a step's
      // output to sequence_enrollments.step_outputs — rather than being handed
      // to unenrollContact, which has no column to keep it in.
      output: {
        sequence_id: targetSequenceId,
        unenrolled: result.unenrolled,
        reason: "remove_from_campaign workflow step",
      },
    }
  },
}
