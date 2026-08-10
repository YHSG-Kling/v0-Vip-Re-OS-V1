"use server";

import { createServiceClient } from "@/lib/supabase/service";
import { isValidUUID } from "@/lib/validations";
import { getOfferLifecycleState } from "./track-offer-lifecycle";
import { evaluateOfferLimit, limitProximity } from "@/lib/offers/multi-offer-rules";

/**
 * System 7.1A Domain 2: Multi-Offer Management
 * Module: Multi-Offer Handler
 *
 * Enforces multi-offer governance rules:
 * - Max 3 pending offers per buyer
 * - No duplicate offers on same listing
 * - Conflicts detection (same buyer, same listing)
 *
 * Per System 5.1D: Multi-offer support WITHOUT state corruption
 * Limit rule lives in the pure lib/offers/multi-offer-rules.ts (unit-tested).
 */

/**
 * Session gate for this module.
 *
 * NOT EXPORTED — this file is `"use server"`, so exporting it would mint another
 * public endpoint. It answers one question: is the caller a signed-in member of
 * the brokerage that owns this contact, and what is that brokerage?
 *
 * Both reads destructure `error`: supabase-js RESOLVES a refused query, so
 * `const { data }` alone renders "RLS refused" and "no such contact"
 * identically. A gate must fail CLOSED and say which it was.
 */
async function requireContactTenant(contactId: string): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const { createClient } = await import("@/lib/supabase/server");
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return { ok: false, error: "Unauthorized" };

  const svc = createServiceClient();
  const [callerRes, contactRes] = await Promise.all([
    svc.from("users").select("brokerage_id").eq("id", user.id).maybeSingle(),
    svc.from("contacts").select("brokerage_id").eq("id", contactId).maybeSingle(),
  ]);
  if (callerRes.error)  return { ok: false, error: "Could not verify the caller" };
  if (contactRes.error) return { ok: false, error: "Could not read the contact" };

  const callerBrokerageId = (callerRes.data?.brokerage_id ?? null) as string | null;
  if (!callerBrokerageId) return { ok: false, error: "Brokerage not configured" };
  if (!contactRes.data) return { ok: false, error: "Contact not found" };
  if ((contactRes.data.brokerage_id ?? null) !== callerBrokerageId) {
    return { ok: false, error: "Forbidden" };
  }
  return { ok: true, userId: user.id, brokerageId: callerBrokerageId };
}

/**
 * Check if buyer can submit another offer
 */
export async function canBuyerSubmitOffer(
  contactId: string
): Promise<{ 
  success: boolean; 
  can_submit: boolean; 
  reason?: string; 
  pending_count?: number 
}> {
  try {
    if (!isValidUUID(contactId)) {
      return { success: false, can_submit: false, reason: "Invalid contact ID" };
    }

    const supabase = createServiceClient();

    // Get all offers for this buyer
    const { data: offers, error } = await supabase
      .from("offers")
      .select("id")
      .eq("contact_id", contactId);

    if (error) throw error;

    // Check lifecycle state for each offer
    let pendingCount = 0;
    for (const offer of offers || []) {
      const stateResult = await getOfferLifecycleState(offer.id);
      if (stateResult.success && stateResult.data?.current_state === "PENDING") {
        pendingCount++;
      }
    }

    const verdict = evaluateOfferLimit(pendingCount);

    // Emit the governance signal this module was built to raise. limitProximity
    // is the pure classifier and its values are exactly emitMultiOfferEvent's
    // event vocabulary — the two halves were written for each other and simply
    // never joined up, so "approaching_limit" / "at_limit" had no emitter.
    // Best-effort: an alert that cannot be recorded must never fail the gate.
    const proximity = limitProximity(pendingCount);
    if (proximity !== "clear") {
      await emitMultiOfferEvent(
        contactId,
        proximity === "at_limit" ? "at_limit" : "approaching_limit",
        { pending_count: pendingCount, max_pending: 3 },
      ).catch(() => {});
    }

    return {
      success: true,
      can_submit: verdict.can_submit,
      reason: verdict.reason,
      pending_count: pendingCount
    };
  } catch (error: any) {
    console.error("[System 7.1A] Error checking multi-offer eligibility:", error);
    return { success: false, can_submit: false, reason: error.message };
  }
}

/**
 * Check for duplicate offer on same listing.
 *
 * GATED. This is `"use server"` — a public HTTP endpoint — and it ran entirely
 * on `createServiceClient()` with no session at all. Anyone who knew (or
 * guessed) a contact uuid + listing uuid could ask any tenant's database
 * whether that buyer has a live offer on that property, and get the offer's id
 * and lifecycle state back. That is deal intelligence about another brokerage's
 * clients, served to an unauthenticated caller.
 *
 * It now proves a session and that the CONTACT belongs to the caller's
 * brokerage — the same door `emitMultiOfferEvent` below already uses, so the
 * two halves of this module answer to the same tenant. There is no unattended
 * caller to strand: this function had no caller of any kind, and its one
 * in-repo call site (app/actions/buyer-offers.ts:createOffer) runs inside an
 * agent's session.
 *
 * `has_duplicate` counts only NON-TERMINAL offers, so a buyer who was rejected
 * on a property may offer again.
 *
 * ── ABSORBED lib/buyer-offer/lifecycle-event-map.ts:detectConflictingOffers ───
 * That function asked the SAME question (same buyer + same listing, is there a
 * live offer already?) and has been deleted. This is the survivor. Read side by
 * side, it had exactly two things this did not, and BOTH are merged in below:
 *
 *   1. `excludeOfferId` — leave one offer out of its own conflict scan. Needed
 *      the moment the check is run for an offer that already exists (an amend or
 *      a re-submit), where without it the offer collides with itself and every
 *      such call reports a false duplicate.
 *   2. the FULL list of live offers, not just the first hit. The single
 *      `existing_offer_id` is enough to BLOCK, but not enough to TELL the agent
 *      what to resolve when a buyer has more than one live offer on a property.
 *
 * Three things it did were NOT ported, because they are defects, and the class
 * is fixed here instead:
 *
 *   · NO TENANT FILTER. It queried `offers` on a service client by contact +
 *     listing with no `brokerage_id` scope at all. This function proves a
 *     session and that the CONTACT belongs to the caller's brokerage
 *     (`requireContactTenant`) before it reads anything.
 *   · IT SWALLOWED THE READ ERROR (`const { data: offers } = …`). supabase-js
 *     RESOLVES a refused query, so a refusal and "this buyer has no offers"
 *     were the same value, and a refusal read back as "no conflict" — a gate
 *     failing OPEN. `error` is destructured here and a failed read returns
 *     `success:false` WITH the message rather than a confident `false`.
 *   · IT ONLY COUNTED `PENDING`. A COUNTERED offer — a live negotiation — was
 *     not a conflict. This counts every NON-TERMINAL state, which is the
 *     superset, and lets the caller decide how much of it binds (the one live
 *     caller, `app/actions/buyer-offers.ts:createOffer`, deliberately lets a
 *     stale DRAFT through so an abandoned draft cannot lock a buyer out).
 *
 * ⚠ The one caller currently treats a FAILED check as "no duplicate"
 * (`if (dupe.success && dupe.has_duplicate …)`), i.e. it fails open. That call
 * site is in app/actions/buyer-offers.ts, which is outside this slice; recorded
 * in docs/wave7-slice-derivations.md.
 */
export async function checkDuplicateOffer(
  contactId: string,
  listingId: string,
  /**
   * Merged from `detectConflictingOffers`. An offer never conflicts with itself:
   * pass the offer being amended/re-submitted so it is left out of the scan.
   */
  excludeOfferId?: string
): Promise<{
  success: boolean;
  has_duplicate: boolean;
  existing_offer_id?: string;
  existing_state?: string;
  /** Merged from `detectConflictingOffers`: EVERY live offer, not just the first. */
  conflicting_offer_ids?: string[];
  error?: string;
}> {
  try {
    if (!isValidUUID(contactId) || !isValidUUID(listingId)) {
      return { success: false, has_duplicate: false, error: "Invalid contact or listing id" };
    }
    if (excludeOfferId !== undefined && !isValidUUID(excludeOfferId)) {
      return { success: false, has_duplicate: false, error: "Invalid offer id to exclude" };
    }

    const tenant = await requireContactTenant(contactId);
    if (!tenant.ok) return { success: false, has_duplicate: false, error: tenant.error };

    const supabase = createServiceClient();

    // Find existing offers for this buyer on this listing, inside the caller's
    // tenant. `detectConflictingOffers` omitted the brokerage filter entirely
    // and expressed the exclusion as `.neq("id", excludeOfferId || "")` — an
    // empty-string uuid comparison, which Postgres rejects as malformed input
    // rather than matching nothing, so the no-exclusion path was one error away
    // from returning zero rows. The filter is applied conditionally instead.
    let query = supabase
      .from("offers")
      .select("id")
      .eq("contact_id", contactId)
      .eq("listing_id", listingId)
      .eq("brokerage_id", tenant.brokerageId);
    if (excludeOfferId) query = query.neq("id", excludeOfferId);

    const { data: offers, error } = await query;

    if (error) throw error;

    if (!offers || offers.length === 0) {
      return { success: true, has_duplicate: false, conflicting_offer_ids: [] };
    }

    // Every offer still active (not terminal), not just the first.
    const conflicting: Array<{ id: string; state: string }> = [];
    for (const offer of offers) {
      const stateResult = await getOfferLifecycleState(offer.id);
      if (stateResult.success && stateResult.data && !stateResult.data.is_terminal) {
        conflicting.push({ id: offer.id, state: stateResult.data.current_state });
      }
    }

    if (conflicting.length === 0) {
      return { success: true, has_duplicate: false, conflicting_offer_ids: [] };
    }

    // The third event this module defines and never raised. Raised ONCE per
    // check, naming the whole conflicting set. Best-effort — a signal that
    // cannot be recorded must never change the answer.
    await emitMultiOfferEvent(contactId, "duplicate_attempted", {
      listing_id: listingId,
      existing_offer_id: conflicting[0].id,
      existing_state: conflicting[0].state,
      conflicting_offer_ids: conflicting.map((c) => c.id),
    }).catch(() => {});

    return {
      success: true,
      has_duplicate: true,
      existing_offer_id: conflicting[0].id,
      existing_state: conflicting[0].state,
      conflicting_offer_ids: conflicting.map((c) => c.id),
    };
  } catch (error: any) {
    console.error("[System 7.1A] Error checking duplicate offer:", error);
    // The message is RETURNED, not just logged: a caller that cannot tell
    // "no duplicate" from "the check did not run" will fail open by default.
    return { success: false, has_duplicate: false, error: error?.message ?? "Duplicate check failed" };
  }
}

/**
 * Get all active offers for a buyer
 */
export async function getBuyerActiveOffers(
  contactId: string
): Promise<{
  success: boolean;
  offers?: Array<{
    offer_id: string;
    listing_id: string;
    listing_address: string;
    state: string;
    state_since: string;
  }>;
  error?: string;
}> {
  try {
    if (!isValidUUID(contactId)) {
      return { success: false, error: "Invalid contact ID" };
    }

    const supabase = createServiceClient();

    // Get all offers for this buyer
    const { data: offers, error: offersError } = await supabase
      .from("offers")
      .select("id, listing_id, listings(address)")
      .eq("contact_id", contactId);

    if (offersError) throw offersError;

    const activeOffers = [];
    for (const offer of offers || []) {
      const stateResult = await getOfferLifecycleState(offer.id);
      if (stateResult.success && stateResult.data && !stateResult.data.is_terminal) {
        activeOffers.push({
          offer_id: offer.id,
          listing_id: offer.listing_id,
          listing_address: (offer as any).listings?.address || "Unknown",
          state: stateResult.data.current_state,
          state_since: stateResult.data.state_since
        });
      }
    }

    return { success: true, offers: activeOffers };
  } catch (error: any) {
    console.error("[System 7.1A] Error getting buyer active offers:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Emit multi-offer event (for orchestration/alerts)
 */
export async function emitMultiOfferEvent(
  contactId: string,
  eventType: "approaching_limit" | "at_limit" | "duplicate_attempted",
  metadata: any
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(contactId)) {
      return { success: false, error: "Invalid contact ID" };
    }

    // Auth gate — previously unauthenticated, letting any caller forge
    // multi_offer signals against any contact's activity log. Now the ONE gate
    // this module uses, shared with checkDuplicateOffer.
    const tenant = await requireContactTenant(contactId)
    if (!tenant.ok) return { success: false, error: tenant.error }

    const supabase = createServiceClient();

    const { error } = await supabase.from("activities").insert({
      brokerage_id: tenant.brokerageId,
      entity_type: "contact",
      entity_id: contactId,
      activity_type: "multi_offer_signal",
      metadata: {
        event_type: `buyer.offer.${eventType}`,
        ...metadata,
        timestamp: new Date().toISOString()
      }
    });

    if (error) throw error;

    return { success: true };
  } catch (error: any) {
    console.error("[System 7.1A] Error emitting multi-offer event:", error);
    return { success: false, error: error.message };
  }
}
