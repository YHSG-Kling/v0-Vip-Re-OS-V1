/**
 * Segment operation adapters — add_to_segment, remove_from_segment and
 * remove_from_campaign. These are control-flow steps, not message dispatches.
 *
 * ── THREE STEPS, TWO TABLES, TWO BUSINESS PROCESSES ─────────────────────────
 *
 * `add_to_segment` / `remove_from_segment` open and close a membership in
 * `contact_segments` — WHICH MARKETING LIST this person is on. That membership
 * is what `lib/marketing/email-campaign-sender.ts:144` resolves a
 * segment-targeted campaign's recipients from.
 *
 * `remove_from_campaign` writes `sequence_enrollments` — WHETHER THIS
 * SEQUENCE IS STILL RUNNING for this person. Its `body` holds a sequence_id,
 * its effect is "nothing after this step runs", and it names no segment at all.
 *
 * They were compared before `remove_from_segment` was written, because the
 * names invite the assumption that one is the other. They are not:
 *   · Different tables, different rows, different readers.
 *   · Leaving a nurture sequence does not mean leaving the "past clients" list,
 *     and a contact can sit in a segment having never been enrolled in any
 *     sequence — the segment is the audience, the enrollment is the run.
 *   · `remove_from_campaign` has no way to know WHICH segment it would clear:
 *     its one input is a sequence id. Overloading it would have to guess.
 * So the segment removal is a step of its own, and neither one was deleted.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"
import { unenrollContact } from "@/lib/campaign-sequences/enrollment-engine"
import { addContactToSegment, removeContactFromSegment } from "@/lib/marketing/segment-membership"

export const addToSegmentAdapter: ChannelAdapter = {
  channel: "add_to_segment",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, contact, brokerageId } = ctx

    if (!contact?.id || !step.body) {
      return { status: "skipped", providerKey: "segment", error: "No contact or segment ID" }
    }

    const segmentId = step.body // body holds the segment_id for this step type

    // TOMBSTONE — the inline `.upsert()` that stood here is DELETED. Survivor:
    // lib/marketing/segment-membership.ts:120 `addContactToSegment`, which now
    // owns both halves of this table. The copy did not name `removed_at` in its
    // payload, so on conflict it left a prior removal in place and the contact
    // stayed invisible to the sender's `removed_at IS NULL` filter — an add step
    // that silently did nothing for anyone ever removed. It also discarded the
    // result entirely, so a refused upsert and a written membership were
    // byte-identical (§3). Both fixed at the survivor.
    const result = await addContactToSegment({
      contactId: contact.id,
      segmentId,
      brokerageId,
    })

    if (!result.success) {
      return { status: "failed", providerKey: "segment", error: result.error }
    }

    return {
      status: "sent",
      providerKey: "segment",
      // `readded` lands in step_outputs (the executor persists a step's output
      // to sequence_enrollments.step_outputs) so that an automation putting
      // someone BACK on a list they had been taken off is on the record rather
      // than indistinguishable from a first-time add.
      output: { segment_id: segmentId, readded: result.readded },
    }
  },
}

export const removeFromSegmentAdapter: ChannelAdapter = {
  channel: "remove_from_segment",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, contact, brokerageId } = ctx

    if (!contact?.id || !step.body) {
      return { status: "skipped", providerKey: "segment", error: "No contact or segment ID" }
    }

    const segmentId = step.body // body holds the segment_id, same as the add step

    const result = await removeContactFromSegment({
      contactId: contact.id,
      segmentId,
      brokerageId,
    })

    // "Already off the list" is the step's desired outcome and must not fail the
    // enrollment; "there is no such membership here" means the predicate matched
    // nothing and the step did NOT do what it says it did, so it is said out loud
    // rather than reported as a successful removal.
    if (!result.success) {
      return { status: "failed", providerKey: "segment", error: result.error }
    }

    return {
      status: "sent",
      providerKey: "segment",
      output: {
        segment_id: segmentId,
        removed: result.removed,
        state: result.state,
      },
    }
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
