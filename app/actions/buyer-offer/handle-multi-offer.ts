"use server";

import { createServiceClient } from "@/lib/supabase/service";
import { isValidUUID } from "@/lib/validations";
import {
  deriveOfferStateFromActivities,
  isTerminalOfferState,
  type OfferState,
} from "@/lib/buyer-offer/offer-lifecycle";
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
 *
 * ── TWO GATES, ONE LETTER APART. READ THIS BEFORE TOUCHING EITHER ────────────
 *
 *   this file:                       canBuyerSubmitOffer  (SINGULAR)
 *   app/actions/buyer-lifecycle-core: canBuyerSubmitOffers (PLURAL)
 *
 * They answer DIFFERENT questions and neither is a duplicate of the other:
 *
 *   · SINGULAR — the LIMIT gate. "How many offers does this buyer already have
 *     PENDING, and is that under the cap?" Pure rule in
 *     lib/offers/multi-offer-rules.ts:evaluateOfferLimit. Knows nothing about
 *     the buyer's lifecycle stage or their finances.
 *   · PLURAL — the LIFECYCLE gate. "Is this buyer far enough along, and
 *     financially verified, to be making offers at all?"
 *     (lib/buyer-lifecycle/gating-helpers.ts:isOfferAllowed.) Knows nothing
 *     about how many offers are already out.
 *
 * A buyer can pass either and fail the other, so app/actions/buyer-offers.ts
 * :createOffer binds BOTH — and imports THIS one under the alias
 * `checkPendingOfferLimit` so the call site cannot be misread. The export keeps
 * its name only because renaming it would have to re-baseline
 * scripts/orphan-export-baseline.json, which is outside this slice.
 */

/**
 * One offer's derived lifecycle state, for the readers in this module.
 *
 * Deliberately NOT the `OfferLifecycleState` shape from track-offer-lifecycle.ts:
 * nothing here reads `history`, and this module now derives state through the
 * canonical pure derivation rather than through that file's `"use server"`
 * export (see `deriveStatesForOffers`).
 */
interface DerivedOfferSummary {
  offerId: string;
  state: OfferState;
  stateSince: string;
  isTerminal: boolean;
}

/**
 * Derive the lifecycle state of MANY offers.
 *
 * WHY THIS CALLS THE LIB AND NOT `getOfferLifecycleState`:
 *
 * Every reader in this file used to call
 * `track-offer-lifecycle.ts:getOfferLifecycleState` once per offer. That export
 * is now SESSION-GATED (it was one of the three open `"use server"` reads this
 * slice closed), so calling it in a loop would re-prove the caller's session and
 * re-read the offer's tenant once per offer — N extra round trips to answer a
 * question this module's own gate (`requireContactTenant`) has already settled
 * for the whole set. It would also gate on the OFFER's brokerage per offer,
 * which is the same tenant the contact gate already established.
 *
 * So the loop goes to the CANONICAL derivation directly —
 * lib/buyer-offer/offer-lifecycle.ts:deriveOfferStateFromActivities — which is a
 * pure reader over an injected client and is the single source of truth for
 * "what state is this offer in". No second derivation is introduced here: this
 * function only fans the canonical one out and collects its answers.
 *
 * READABILITY IS ESTABLISHED ONCE, POSITIVELY. `deriveOfferStateFromActivities`
 * reports "this offer has no lifecycle events" and "the activities read was
 * REFUSED" through the same `{ ok: false }` channel, separated only by wording —
 * and a gate must never tell those apart by matching a sentence. So one probe
 * read runs first over the whole offer set with its `error` destructured: if the
 * trail cannot be read, every caller below refuses. If it CAN be read, an offer
 * with no events genuinely has none (createOffer tolerates a failed
 * `buyer.offer.draft.created` write and says so loudly), and skipping it is
 * correct rather than a swallowed refusal.
 *
 * KNOWN LIMIT, stated rather than hidden: this is still one activities read per
 * offer, issued concurrently. A true single-query batch needs a batch entry
 * point on the canonical module itself (`deriveOfferStatesFromActivities`), and
 * lib/buyer-offer/offer-lifecycle.ts is outside this slice — folding the rows
 * here instead would mint the second derivation the offer lane spent a wave
 * deleting.
 */
async function deriveStatesForOffers(
  supabase: ReturnType<typeof createServiceClient>,
  offerIds: string[],
): Promise<{ ok: true; states: DerivedOfferSummary[] } | { ok: false; error: string }> {
  if (offerIds.length === 0) return { ok: true, states: [] };

  // The probe. `error` is destructured because supabase-js RESOLVES a refused
  // query — without this, "the trail is unreadable" and "this buyer's offers
  // have no events yet" arrive as the same value, and the limit gate below
  // would report a pending count of zero for a buyer at the cap.
  const { error: probeError } = await supabase
    .from("activities")
    .select("id")
    .eq("entity_type", "offer")
    .in("entity_id", offerIds)
    .limit(1);

  if (probeError) {
    return { ok: false, error: `Could not read offer lifecycle events: ${probeError.message}` };
  }

  const derived = await Promise.all(
    offerIds.map(async (offerId) => ({
      offerId,
      result: await deriveOfferStateFromActivities(supabase as any, offerId),
    })),
  );

  const states: DerivedOfferSummary[] = [];
  for (const { offerId, result } of derived) {
    if (!result.ok) continue; // proven readable above ⇒ genuinely no events
    states.push({
      offerId,
      state: result.state,
      stateSince: result.at,
      isTerminal: isTerminalOfferState(result.state),
    });
  }

  return { ok: true, states };
}

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
 * THE LIMIT GATE — how many offers does this buyer already have PENDING?
 *
 * (Not the lifecycle gate. See the two-gates note at the top of this file.)
 *
 * GATED. This is `"use server"` — a public HTTP endpoint — and it ran entirely
 * on `createServiceClient()` with no `auth.getUser()` and no tenant check, so
 * any caller holding a contact uuid could ask how many live offers another
 * brokerage's buyer is carrying. It now proves a session and that the CONTACT
 * belongs to the caller's brokerage through `requireContactTenant`, the same
 * door `checkDuplicateOffer` and `emitMultiOfferEvent` already used.
 *
 * FAILS CLOSED IN BOTH DIRECTIONS. A refused read no longer resolves into a
 * pending count of zero: `deriveStatesForOffers` establishes readability first,
 * and the `offers` read below destructures `error`. Pre-rollout every table is
 * EMPTY, so "nothing came back" can never be the thing that lets an offer
 * through — the caller gets `success:false` and must refuse.
 *
 * `pending_offer_ids` is returned so a refusal downstream can NAME what to
 * resolve instead of telling the agent only that they are at a limit.
 */
export async function canBuyerSubmitOffer(
  contactId: string
): Promise<{
  success: boolean;
  can_submit: boolean;
  reason?: string;
  pending_count?: number;
  /** The offers that are actually holding the slots — the remedy, not just the verdict. */
  pending_offer_ids?: string[];
}> {
  try {
    if (!isValidUUID(contactId)) {
      return { success: false, can_submit: false, reason: "Invalid contact ID" };
    }

    const tenant = await requireContactTenant(contactId);
    if (!tenant.ok) return { success: false, can_submit: false, reason: tenant.error };

    const supabase = createServiceClient();

    // Every offer for this buyer, inside the caller's tenant. The brokerage
    // filter is defence in depth behind the gate above — the contact is already
    // proven to be in this brokerage, so an offer of theirs filed under another
    // one is corruption, not a row this count should include.
    const { data: offers, error } = await supabase
      .from("offers")
      .select("id")
      .eq("contact_id", contactId)
      .eq("brokerage_id", tenant.brokerageId);

    if (error) {
      // RETURNED, not thrown into a generic catch: a caller that cannot tell
      // "zero pending" from "the count did not run" will fail open.
      return {
        success: false,
        can_submit: false,
        reason: `Could not read this buyer's offers: ${error.message}`,
      };
    }

    const derived = await deriveStatesForOffers(supabase, (offers ?? []).map((o) => o.id));
    if (!derived.ok) {
      return { success: false, can_submit: false, reason: derived.error };
    }

    const pending = derived.states.filter((s) => s.state === "PENDING");
    const pendingCount = pending.length;
    const pendingOfferIds = pending.map((s) => s.offerId);

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
      pending_count: pendingCount,
      pending_offer_ids: pendingOfferIds,
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

    // Every offer still active (not terminal), not just the first. Derived
    // through the canonical pure derivation rather than through the (now
    // session-gated) `getOfferLifecycleState` export — see deriveStatesForOffers.
    const derived = await deriveStatesForOffers(supabase, offers.map((o) => o.id));
    if (!derived.ok) {
      // A conflict check that could not read the trail must not answer "no
      // conflict" — that is the gate-fails-open class this function was
      // consolidated to remove.
      return { success: false, has_duplicate: false, error: derived.error };
    }
    const conflicting = derived.states
      .filter((s) => !s.isTerminal)
      .map((s) => ({ id: s.offerId, state: s.state as string }));

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
 * Get all active offers for a buyer.
 *
 * 🚨 THIS WAS THE SHARPEST OF THE THREE. It is `"use server"` — a public HTTP
 * endpoint — running on `createServiceClient()` with no `auth.getUser()` and no
 * tenant check, AND it is invoked from a CLIENT component
 * (app/components/offer/multi-offer-status-banner.tsx) with a bare `contactId`.
 * So it was reachable from any signed-in browser with any contact uuid in the
 * database, and it answers with another brokerage's buyer's LIVE offers: the
 * property they are bidding on and what state each negotiation is in. In this
 * domain that is deal intelligence about a rival's clients.
 *
 * Gated with `requireContactTenant` — the door already in this module — and the
 * `offers` read is additionally anchored on the tenant that gate resolved from
 * the CONTACT ROW, never from the caller.
 *
 * Both reads destructure `error`, and the lifecycle derivation establishes
 * readability before any offer is dropped from the list: an empty list must mean
 * "no live offers", never "the read was refused".
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

    const tenant = await requireContactTenant(contactId);
    if (!tenant.ok) return { success: false, error: tenant.error };

    const supabase = createServiceClient();

    // Every offer for this buyer, inside the caller's own tenant.
    const { data: offers, error: offersError } = await supabase
      .from("offers")
      .select("id, listing_id, listings(address)")
      .eq("contact_id", contactId)
      .eq("brokerage_id", tenant.brokerageId);

    if (offersError) {
      return { success: false, error: `Could not read this buyer's offers: ${offersError.message}` };
    }

    const rows = offers ?? [];
    const derived = await deriveStatesForOffers(supabase, rows.map((o) => o.id));
    if (!derived.ok) return { success: false, error: derived.error };

    const byId = new Map(rows.map((o) => [o.id, o]));
    const activeOffers = derived.states
      .filter((s) => !s.isTerminal)
      .map((s) => {
        const offer = byId.get(s.offerId) as any;
        return {
          offer_id: s.offerId,
          listing_id: offer?.listing_id,
          listing_address: offer?.listings?.address || "Unknown",
          state: s.state as string,
          state_since: s.stateSince,
        };
      });

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
