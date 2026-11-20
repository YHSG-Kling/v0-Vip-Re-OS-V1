/**
 * lib/marketing/segment-membership.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE WRITER OF `contact_segments`. Both halves of the membership, in one
 * place, so the add and the remove cannot drift apart the way the add and the
 * *missing* remove did.
 *
 * ── THE DEFECT THIS FILE EXISTS TO CLOSE ────────────────────────────────────
 *
 * `contact_segments` has carried a `removed_at` column since 062. The reader
 * honours it — `lib/marketing/email-campaign-sender.ts:148` resolves a
 * segment-targeted campaign's recipients with `.is("removed_at", null)` — and
 * the contact detail page filters on it the same way. NOTHING IN THE TREE EVER
 * WROTE IT. The only writer of the table at all was the workflow
 * `add_to_segment` step.
 *
 * That is not a cosmetic one-sided column. It is a live deliverability and
 * consent problem: once a contact landed in a marketing segment they received
 * that segment's campaigns FOREVER, because the product had no way — automated
 * or manual — to say "take them off this list".
 *
 * ── WHAT THIS IS *NOT*: THE CONSENT LANE ────────────────────────────────────
 *
 * Segment membership is an AUDIENCE question ("is this person on this list?").
 * Consent is a DIFFERENT question ("may we contact this person at all?"), and
 * it already has exactly one canonical home:
 *
 *   lib/kernel/compliance/check-suppression.ts `checkSuppression`
 *     ← reads contacts.email_unsubscribed / email_opt_out / sms_* / dnc_status
 *       and `contact_suppression_list`
 *     ← called by lib/providers/dispatch.ts:337 (email) and :561 (SMS) before
 *       EVERY send, and it fails closed on an unreadable row.
 *   lib/lead-intent/lead-opt-out.ts + app/actions/ai-isa/process-opt-out.ts
 *     ← the writers of that lane.
 *
 * So (§6, one vocabulary per function) this module deliberately writes NO
 * suppression row and sets NO opt-out flag, and the opt-out lane deliberately
 * clears no segment membership. The boundary is load-bearing in both
 * directions:
 *   · Removing someone from a segment must NOT read as "they revoked consent" —
 *     an agent pruning a list is curation, not a legal signal.
 *   · An opt-out must NOT be implemented as "drop them from their segments",
 *     because that would leave the suppression invisible to every OTHER send
 *     path, and a later `add_to_segment` step would silently undo it.
 * A suppressed contact who is still a segment member is resolved as a recipient
 * here and then REFUSED at dispatch, which is the correct order: the consent
 * gate is the last word, and no segment write can talk over it.
 *
 * ── RE-ADD SEMANTICS: ONE ROW, `removed_at` CLEARED ─────────────────────────
 *
 * `CONSTRAINT contact_segments_unique UNIQUE (contact_id, segment_id)` (062)
 * settles this — a second row for the same pair is not insertable at all, so
 * "insert a new row per stint" was never an option the schema allowed. Re-add
 * therefore REUSES the row and clears `removed_at`.
 *
 * The pre-existing `add_to_segment` upsert did not name `removed_at` in its
 * payload, so on conflict it updated `added_at` and left `removed_at` set — a
 * re-added contact stayed invisible to the sender's filter. That made the add
 * path silently inert for anyone who had ever been removed. Fixed here by
 * naming `removed_at: null` in the payload.
 *
 * It is not silent: `addContactToSegment` reads the prior row first and reports
 * `readded: true` when it is clearing a real removal, so the workflow adapter
 * can persist that fact into the step's `step_outputs` and an operator can see
 * that an automation put someone back on a list they had been taken off.
 *
 * ── COUNTED WRITES ──────────────────────────────────────────────────────────
 *
 * §3: an UPDATE matching NOTHING resolves with `error: null` and an empty
 * `data`, byte-identical to one that worked. So every write here `.select()`s
 * and returns its ROW COUNT, and `removeContactFromSegment` additionally probes
 * on a zero count to separate the three things zero can mean — already removed
 * (idempotent no-op), never a member, or the tenant predicate refused. Whether
 * zero is a failure is the caller's call, not this module's.
 */

import { createServiceClient } from "@/lib/supabase/service"

export interface SegmentMembershipParams {
  contactId: string
  /** The segment this membership is in. `contact_segments.segment_id` carries no FK. */
  segmentId: string
  /** REQUIRED, and it must come from the session — never from a request body (§4). */
  brokerageId: string
}

export interface AddToSegmentResult {
  success: boolean
  /** Rows written (1 on success — the unique constraint admits no more). */
  added: number
  /** TRUE when this add cleared a real `removed_at`, i.e. put someone back on a list. */
  readded: boolean
  error?: string
}

export interface RemoveFromSegmentResult {
  success: boolean
  /** Rows the removal actually matched. 0 is not automatically a failure — see `state`. */
  removed: number
  /**
   * What zero rows MEANT, resolved rather than guessed:
   *   "removed"        — an active membership was closed by this call.
   *   "already_removed" — the row exists and `removed_at` was already set (no-op).
   *   "not_a_member"   — no such membership in this brokerage. Either the contact
   *                      was never in that segment, or the tenant predicate refused.
   */
  state: "removed" | "already_removed" | "not_a_member"
  error?: string
}

/**
 * PUT A CONTACT ON A SEGMENT — idempotent, and honest about re-adds.
 *
 * Survivor of the inline upsert that stood in
 * `lib/workflow/adapters/segment-ops.ts:21`; that adapter now calls this.
 */
export async function addContactToSegment(
  params: SegmentMembershipParams,
): Promise<AddToSegmentResult> {
  const supabase = createServiceClient()

  // Prior state FIRST — the upsert returns the row as it is AFTER the write, so
  // it cannot tell us whether we just cleared a removal. Read is tenant-scoped
  // for the same reason the write is.
  const { data: prior, error: priorError } = await supabase
    .from("contact_segments")
    .select("id, removed_at")
    .eq("brokerage_id", params.brokerageId)
    .eq("contact_id", params.contactId)
    .eq("segment_id", params.segmentId)
    .maybeSingle()

  if (priorError) {
    return { success: false, added: 0, readded: false, error: priorError.message }
  }

  const readded = !!(prior as { removed_at: string | null } | null)?.removed_at

  const { data, error } = await supabase
    .from("contact_segments")
    .upsert(
      {
        contact_id: params.contactId,
        segment_id: params.segmentId,
        brokerage_id: params.brokerageId,
        added_at: new Date().toISOString(),
        // NAMED DELIBERATELY. Without it, `onConflict` leaves a prior
        // `removed_at` in place and the sender's `.is("removed_at", null)`
        // filter keeps excluding a contact an automation just re-added.
        removed_at: null,
      },
      { onConflict: "contact_id,segment_id" },
    )
    .select("id")

  if (error) return { success: false, added: 0, readded: false, error: error.message }

  return { success: true, added: data?.length ?? 0, readded }
}

/**
 * TAKE A CONTACT OFF A SEGMENT.
 *
 * Closes the membership rather than deleting the row: the sender and the
 * contact page both read `removed_at IS NULL`, and a DELETE would erase the
 * fact that the person was ever on the list — which is the one thing an
 * operator asks about after a complaint. Also, the unique constraint means the
 * row is the ONLY place that history can live.
 */
export async function removeContactFromSegment(
  params: SegmentMembershipParams,
): Promise<RemoveFromSegmentResult> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("contact_segments")
    .update({ removed_at: new Date().toISOString() })
    .eq("brokerage_id", params.brokerageId)
    .eq("contact_id", params.contactId)
    .eq("segment_id", params.segmentId)
    .is("removed_at", null)
    .select("id")

  if (error) {
    return { success: false, removed: 0, state: "not_a_member", error: error.message }
  }

  const removed = data?.length ?? 0
  if (removed > 0) return { success: true, removed, state: "removed" }

  // Zero rows. Three different things, and the caller cannot act on the count
  // alone: probe for the membership WITHOUT the `removed_at IS NULL` arm, under
  // the same tenant predicate that just matched nothing.
  const { data: probe, error: probeError } = await supabase
    .from("contact_segments")
    .select("id, removed_at")
    .eq("brokerage_id", params.brokerageId)
    .eq("contact_id", params.contactId)
    .eq("segment_id", params.segmentId)
    .maybeSingle()

  if (probeError) {
    // We know the update matched nothing and we cannot say why. Fail closed —
    // "nobody could check" must not render as "removed" (§4).
    return { success: false, removed: 0, state: "not_a_member", error: probeError.message }
  }

  if (probe) return { success: true, removed: 0, state: "already_removed" }
  return { success: false, removed: 0, state: "not_a_member", error: "No such segment membership for this contact in this brokerage" }
}
