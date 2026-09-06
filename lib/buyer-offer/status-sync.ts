// NOT a server-action module (2026-09-03, lane R3-A; template
// lib/behavior-learning/preference-updater.ts:1-9). The module-level "use server"
// that stood here published syncOfferStatus(offerId, event) and
// getCurrentOfferStatus(offerId) as public HTTP doors with no gate — a service
// client writing offers.status for any offers.id a session chose to name.
// Every caller is in-process server code (re-verified 2026-09-03):
//   · lib/buyer-offer/index.ts:65-68 (the barrel), whose value importers are
//     app/actions/buyer-offer/submit-for-signature.ts:7 and
//     app/actions/buyer-offer/respond-to-counter.ts:7 — both "use server"
// so the directive published nothing anyone needed. `server-only` makes a future
// client import fail at build time instead of bundling the service credential.
import "server-only"

/**
 * System 7.1B - Status Column Sync
 * 
 * The offers.status column is an OPERATIONAL INDEX ONLY.
 * It REFLECTS lifecycle but never DRIVES lifecycle.
 * 
 * After every lifecycle event, status must be updated to match.
 */

import { createServiceClient } from "@/lib/supabase/service"
import {
  EVENT_TO_STATUS,
  OFFER_LIFECYCLE_EVENT_TYPES,
  type OfferEvent,
} from "./offer-lifecycle"
import { isValidUUID } from "@/lib/validations"

// DELETED FROM HERE: a private 9-entry `EVENT_TO_STATUS` map.
// SURVIVOR: lib/buyer-offer/offer-lifecycle.ts:EVENT_TO_STATUS.
//
// The survivor carries this file's nine rows VERBATIM — draft.created→draft,
// signature.requested→submitted, sent.to.listing.agent→under_review,
// counter.received→countered, accepted→accepted, rejected→rejected,
// withdrawn→withdrawn, expired→expired, voided→voided — and adds the five events
// the OTHER derivations already knew (submitted, counter.submitted,
// counter.accepted, counter.rejected, countered), mapped to literals the offer
// screens already render. Nothing was invented and nothing was dropped.
//
// The rule this module was written to hold is UNCHANGED: `offers.status` is an
// OPERATIONAL INDEX ONLY. It REFLECTS lifecycle and never DRIVES it. The
// authority is the activities trail; this column exists so the screens have
// something cheap to read.

/**
 * Sync offers.status to match latest lifecycle event
 *
 * Call this after emitting any lifecycle event.
 *
 * ⚠ BOTH CALL SITES DISCARD THIS RESULT.
 * `app/actions/buyer-offer/submit-for-signature.ts:257` and
 * `app/actions/buyer-offer/respond-to-counter.ts:171` both call
 * `await syncOfferStatus(offerId)` and ignore the returned object, so a total
 * failure — including the "no lifecycle events found" case, which is what BOTH
 * of them actually hit today because they file their offer events under
 * `entity_type: 'contact'` instead of the canonical
 * `entity_type='offer'` + `entity_id` key — is completely invisible: the caller
 * reports success, `offers.status` never moves, and every screen keeps showing
 * the stale value.
 *
 * Those two files are not this module's to fix. What IS in this module's power
 * is refusing to fail quietly, so every failure path below now logs at
 * `console.error` WITH the offer id. That is the only trace an operator gets
 * until the callers are repaired. Recorded in docs/wave7-slice-derivations.md.
 */
export async function syncOfferStatus(
  offerId: string
): Promise<{ success: boolean; newStatus?: string; error?: string }> {
  if (!isValidUUID(offerId)) {
    return { success: false, error: "Invalid offer ID" }
  }

  const supabase = createServiceClient()

  // Get latest lifecycle event
  const { data: latestEvent, error: eventError } = await supabase
    .from("activities")
    .select("activity_type, created_at")
    .eq("entity_type", "offer")
    .eq("entity_id", offerId)
    .in("activity_type", OFFER_LIFECYCLE_EVENT_TYPES as string[])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (eventError) {
    console.error(
      `[offer-lifecycle] syncOfferStatus: could not read lifecycle events for offer ${offerId} — offers.status NOT updated:`,
      eventError,
    )
    return { success: false, error: eventError.message }
  }

  if (!latestEvent) {
    // NOT a benign empty. It means no writer has ever filed a lifecycle event on
    // the canonical key for this offer, so `offers.status` is frozen at whatever
    // the row was created with while the UI presents it as current. Both callers
    // throw this result away, so this line is the whole alarm.
    console.error(
      `[offer-lifecycle] syncOfferStatus: NO lifecycle events on entity_type='offer' + entity_id='${offerId}'. ` +
        `offers.status was NOT updated and is now stale. Either the offer has no events, or its writer filed them ` +
        `under the wrong key (entity_type='contact', or entity_id omitted). ` +
        `The caller discards this result, so nothing downstream will report it.`,
    )
    return { success: false, error: "No lifecycle events found" }
  }

  const newStatus = EVENT_TO_STATUS[latestEvent.activity_type as OfferEvent]

  if (!newStatus) {
    // Unreachable while the `.in(...)` filter and the map share one source
    // (OFFER_LIFECYCLE_EVENT_TYPES is Object.values(OFFER_EVENT) and
    // EVENT_TO_STATUS is keyed over the same union), but a future event added
    // without a status mapping must not silently leave the index behind.
    console.error(
      `[offer-lifecycle] syncOfferStatus: event '${latestEvent.activity_type}' on offer ${offerId} has no status mapping — offers.status NOT updated.`,
    )
    return { success: false, error: "Unknown event type" }
  }

  // Update offers.status
  const { error: updateError } = await supabase
    .from("offers")
    .update({ status: newStatus })
    .eq("id", offerId)

  if (updateError) {
    console.error(
      `[offer-lifecycle] syncOfferStatus: could not write status '${newStatus}' to offer ${offerId}:`,
      updateError,
    )
    return { success: false, error: updateError.message }
  }

  return { success: true, newStatus }
}

/**
 * Get current offer status (derived from events).
 *
 * Reads the SAME canonical map — it does not write, so it is safe for any
 * surface that wants the operational literal without touching the row.
 */
export async function getCurrentOfferStatus(
  offerId: string
): Promise<{ success: boolean; status?: string; error?: string }> {
  if (!isValidUUID(offerId)) {
    return { success: false, error: "Invalid offer ID" }
  }

  const supabase = createServiceClient()

  const { data: latestEvent, error } = await supabase
    .from("activities")
    .select("activity_type")
    .eq("entity_type", "offer")
    .eq("entity_id", offerId)
    .in("activity_type", OFFER_LIFECYCLE_EVENT_TYPES as string[])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error(
      `[offer-lifecycle] getCurrentOfferStatus: could not read lifecycle events for offer ${offerId}:`,
      error,
    )
    return { success: false, error: error.message }
  }

  if (!latestEvent) {
    console.error(
      `[offer-lifecycle] getCurrentOfferStatus: NO lifecycle events on entity_type='offer' + entity_id='${offerId}'.`,
    )
    return { success: false, error: "No events found" }
  }

  const status = EVENT_TO_STATUS[latestEvent.activity_type as OfferEvent]

  return { success: true, status }
}
