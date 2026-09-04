// lib/reputation/review-landed.ts
//
// WHAT HAPPENS THE MOMENT A REVIEW LANDS — the half that was written once, in a
// rail nothing called, while the two rails that DO write agent_reviews did
// neither part of it.
//
// MERGED HERE (orphan doctrine §1.1, BURN-C 2026-09-04) from
// lib/kernel/reputation.ts:recordReview and its wrapper
// app/actions/reputation-kernel.ts:recordReviewAction, both now deleted.
//
// Lane L6 recorded on 2026-09-03 that those two could NOT simply be deleted
// against their named survivors — app/actions/multi-persona.ts:submitClientFeedback
// and app/actions/portal-lifetime.ts:submitClientTestimonial — because the
// survivors were not strictly more complete. They insert the review and stop.
// The deleted rail additionally did two things, and both are real defects in
// their absence:
//
//   1. IT CLOSED THE REQUEST THE REVIEW ANSWERS. `review_requests.completed_at`
//      is READ (the reputation workspace loader selects it) and was written by
//      nobody on any live path, so a request sent to a client stayed pending or
//      sent FOREVER — even after that client left the review. The workspace
//      could not tell an outstanding ask from a satisfied one, and every
//      follow-up cadence chased clients who had already done what was asked.
//
//   2. IT EMITTED REVIEW_RECEIVED. lib/kernel/events.ts:9 requires every
//      lifecycle transition to map to exactly one KernelEvent. A review arriving
//      is that transition, and on the live paths the OS never heard about it —
//      no sequence, no notification fan-out, no portal card.
//
// It lives in lib/ rather than being pasted into each survivor because there are
// TWO writers and §6 allows one spelling per function. Both call this; neither
// re-implements it.

import type { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"

type Svc = ReturnType<typeof createServiceClient>

export interface ReviewLandedInput {
  supabase:     Svc
  reviewId:     string
  brokerageId:  string
  /** agents.id of the reviewed agent. Null when the review is unattributed. */
  agentId:      string | null
  /** The reviewer. Without it no request can be attributed — see below. */
  contactId:    string | null
  /** agent_reviews.platform — 'internal', 'google', 'zillow', … */
  platform:     string
  rating?:      number | null
}

export interface ReviewLandedResult {
  /** How many review_requests rows this review closed out. Ordinarily 0 or 1. */
  requestsClosed: number
}

/**
 * Close out the request this review answers, then announce the review.
 *
 * BEST-EFFORT BY CONTRACT: the review row has already been inserted by the
 * caller when this runs. Neither step may turn a review the client successfully
 * left into a thrown error the caller reports as a failure — so every refusal is
 * logged loudly and swallowed, never rethrown. `requestsClosed` is returned so a
 * caller that wants to say "thanks, that closes your open request" can.
 */
export async function onReviewLanded(input: ReviewLandedInput): Promise<ReviewLandedResult> {
  let requestsClosed = 0

  // ── 1. THE REQUEST THIS REVIEW ANSWERS ────────────────────────────────────
  // Requires a contact to match on: an anonymous inbound review cannot be
  // attributed to a particular ask, and guessing would close the wrong one.
  // Matching on agent + tenant + contact + platform is the same predicate the
  // deleted rail used.
  if (input.contactId && input.agentId) {
    const { data: closed, error: closeErr } = await input.supabase
      .from("review_requests")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("agent_id",     input.agentId)
      .eq("brokerage_id", input.brokerageId)
      .eq("contact_id",   input.contactId)
      .eq("platform",     input.platform)
      .in("status",       ["pending", "sent"])
      .is("completed_at", null)
      .select("id")

    // COUNTED (CLAUDE.md §3): an UPDATE matching nothing resolves exactly like
    // one that landed. Zero rows here is the ORDINARY case — a review nobody
    // asked for — so it is not an error; a REFUSAL is, and it is said aloud
    // rather than swallowed into a silent no-op.
    if (closeErr) {
      console.error("[reputation] review request not closed out:", closeErr.message)
    } else {
      requestsClosed = (closed ?? []).length
    }
  }

  // ── 2. THE LIFECYCLE EVENT ────────────────────────────────────────────────
  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    await emitKernelEvent({
      event:       KernelEvent.REVIEW_RECEIVED,
      brokerageId: input.brokerageId,
      entityType:  "agent_review",
      entityId:    input.reviewId,
      contactId:   input.contactId ?? undefined,
      metadata:    { platform: input.platform, rating: input.rating ?? null },
    })
  } catch (err) {
    console.error("[reputation] REVIEW_RECEIVED emit failed:", (err as { message?: string })?.message ?? err)
  }

  return { requestsClosed }
}
