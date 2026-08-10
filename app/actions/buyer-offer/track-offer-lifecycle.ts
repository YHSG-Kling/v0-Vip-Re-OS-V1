"use server";

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { expireOffer } from "@/lib/buyer-offer/expire-offers";
import {
  deriveOfferStateFromActivities,
  isTerminalOfferState,
  type OfferState,
} from "@/lib/buyer-offer/offer-lifecycle";
import { isValidUUID } from "@/lib/validations";

/**
 * System 7.1A Domain 2: Multi-Offer Management
 * Module: Offer Lifecycle Tracker
 * 
 * Tracks offer state transitions through the canonical lifecycle:
 * DRAFT → PENDING → [ACCEPTED|REJECTED|COUNTERED|EXPIRED|WITHDRAWN]
 * 
 * Uses activities table events to derive current state (no columns).
 * Emits lifecycle events for all state changes.
 */

/**
 * The public shape of `getOfferLifecycleState`. Unchanged in every field its two
 * live callers read (`convert-to-transaction.ts:convertOfferToTransaction` reads
 * `current_state`; `handle-multi-offer.ts` reads `current_state`, `is_terminal`
 * and `state_since`).
 *
 * TWO fields moved, and both moved toward the truth:
 *
 *  · `current_state` / `history[].state` are now the canonical `OfferState`
 *    union from lib/buyer-offer/offer-lifecycle.ts rather than a locally
 *    respelled copy plus a bare `string`. Same seven members.
 *
 *  · `history[].actor_id` is `string | null`. `activities.agent_id` is NULLABLE
 *    on the live schema and an unattended expiry sweep files rows with no human
 *    actor, so the old non-nullable `string` was a type that the data could not
 *    honour. No caller reads `history` at all (grepped across
 *    app/ lib/ components/ hooks/ services/ scripts/ — every `getOfferLifecycleState`
 *    call site touches only `current_state`, `is_terminal`, `state_since`).
 *
 *  · `history[].reason` is RESTORED, from the canonical source rather than this
 *    file. The derivation slice was right that re-reading `notes` here would put
 *    a second query over the same rows back into this file, and right to raise
 *    it instead of routing around the contract — so the contract absorbed it:
 *    `offer-lifecycle.ts:deriveOfferStateFromActivities` now selects `notes` and
 *    parses the reason ONCE (`parseReason`, reading `reason` then
 *    `response_type`, null on anything unparseable). No reader touches the raw
 *    blob again, and no caller lost a field.
 */
export interface OfferLifecycleState {
  offer_id: string;
  current_state: OfferState;
  state_since: string;
  history: Array<{
    state: OfferState;
    timestamp: string;
    actor_id: string | null;
    reason: string | null;
  }>;
  is_terminal: boolean;
}

/**
 * Session gate for offer lifecycle transitions.
 *
 * NOT EXPORTED — this module is `"use server"`, so exporting it would mint
 * another public endpoint. It answers one question: is the caller a signed-in
 * member of the brokerage that owns this offer, and what is that brokerage?
 *
 * The tenant is taken from `offers.brokerage_id`, never from the caller. That is
 * the whole point: every writer in this file used to derive `activities.brokerage_id`
 * from a caller-supplied `userId`, which means the audit row for a state change
 * could be filed under the wrong tenant — or under `null`, because `?? null`
 * accepted a user id that resolved to nothing.
 *
 * Both reads destructure `error`. supabase-js resolves a refused query, so
 * `const { data }` alone would render "RLS refused" and "no such offer"
 * identically; in a gate that must fail closed, and it must not be reported as
 * a 404.
 */
async function requireOfferActor(offerId: string): Promise<
  | { ok: true; userId: string; brokerageId: string; responseDeadline: string | null }
  | { ok: false; error: string }
> {
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return { ok: false, error: "Unauthenticated" };

  const svc = createServiceClient();
  const [callerRes, offerRes] = await Promise.all([
    svc.from("users").select("brokerage_id").eq("id", user.id).maybeSingle(),
    svc.from("offers").select("id, brokerage_id, response_deadline").eq("id", offerId).maybeSingle(),
  ]);

  if (callerRes.error) return { ok: false, error: "Could not verify the caller" };
  if (offerRes.error)  return { ok: false, error: "Could not read the offer" };

  const callerBrokerageId = (callerRes.data?.brokerage_id ?? null) as string | null;
  if (!callerBrokerageId) return { ok: false, error: "Brokerage not configured" };

  const offer = offerRes.data;
  if (!offer) return { ok: false, error: "Offer not found" };
  const offerBrokerageId = (offer.brokerage_id ?? null) as string | null;
  if (!offerBrokerageId || offerBrokerageId !== callerBrokerageId) {
    return { ok: false, error: "Forbidden" };
  }

  return {
    ok: true,
    userId: user.id,
    brokerageId: offerBrokerageId,
    responseDeadline: (offer.response_deadline ?? null) as string | null,
  };
}

/**
 * Get current lifecycle state for an offer.
 *
 * REPOINTED onto the ONE derivation:
 * lib/buyer-offer/offer-lifecycle.ts:deriveOfferStateFromActivities.
 *
 * What used to live here — a private 7-name `.in(...)` list and a private
 * `deriveStateFromEvent` map — is deleted. It was one of FOUR copies of the same
 * table (this one, lib/buyer-offer/status-sync.ts's 9-event map,
 * lib/buyer-offer/expire-offers.ts's inlined 7, and the 22 underscore constants
 * in the now-deleted lib/buyer-offer/lifecycle-event-map.ts), and every copy
 * knew a different subset of the events real writers emit. An offer whose latest
 * event was `buyer.offer.signature.requested` or `buyer.offer.counter.received`
 * was INVISIBLE to this reader: it fell through the `.in(...)` filter, so the
 * state reported here was whatever older event happened to precede it.
 *
 * THE KEY is unchanged and still the canonical one — `entity_type='offer'` AND
 * `entity_id=<offer id>` — it now just lives in one place. (This read once said
 * `.eq("entity_type","contact")` and applied the offerId to NOTHING, so on a
 * service client it returned every buyer.offer.* activity in the database, took
 * the most recent, and reported it as the state of THIS offer. That is fixed and
 * stays fixed; the canonical derivation applies both halves of the key.)
 *
 * `deriveOfferStateFromActivities` destructures `error`, so a REFUSED read is no
 * longer reported as "Offer not found" — supabase-js resolves a refused query
 * and the old `if (error) throw` path collapsed both into the same message for
 * the caller. The returned `error` text therefore changed:
 *   no rows  → "Offer has no lifecycle events"   (was "Offer not found")
 *   refusal  → "Could not read offer lifecycle: …" (was "Offer not found")
 * No caller matches on that string; all three in-file callers and both external
 * callers only check `success` and pass `error` through to the operator.
 */
export async function getOfferLifecycleState(
  offerId: string
): Promise<{ success: boolean; data?: OfferLifecycleState; error?: string }> {
  try {
    if (!isValidUUID(offerId)) {
      return { success: false, error: "Invalid offer ID" };
    }

    const supabase = createServiceClient();

    const derived = await deriveOfferStateFromActivities(supabase as any, offerId);
    if (!derived.ok) {
      return { success: false, error: derived.reason };
    }

    const lifecycleState: OfferLifecycleState = {
      offer_id: offerId,
      current_state: derived.state,
      state_since: derived.at,
      history: derived.history.map((h) => ({
        state: h.state,
        timestamp: h.at,
        actor_id: h.actorAgentId,
        reason: h.reason,
      })),
      // From the canonical predicate, not a re-typed array literal.
      is_terminal: isTerminalOfferState(derived.state),
    };

    return { success: true, data: lifecycleState };
  } catch (error: any) {
    console.error("[System 7.1A] Error getting offer lifecycle state:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Submit offer (DRAFT → PENDING)
 *
 * GATED. This is `"use server"` — a public HTTP endpoint — and it authenticated
 * nothing while running on `createServiceClient()`. The only "identity" was a
 * `userId` uuid supplied by the caller, which was then used to look up a
 * `brokerage_id` for the audit row. So any unauthenticated caller who knew (or
 * guessed) an offer uuid could move another tenant's offer DRAFT → PENDING and
 * file the audit trail under a brokerage of their choosing — or under `null`,
 * because `?? null` accepted a user id that resolved to nothing.
 *
 * `requireOfferActor()` (already in this file, previously used only by
 * `markOfferExpired`) is the right door: it proves a session, and takes the
 * tenant from `offers.brokerage_id` rather than from the caller. `userId` is
 * retained and ignored per the house pattern so future call sites keep
 * type-checking.
 */
export async function submitOffer(
  offerId: string,
  /** Ignored — the actor is derived from the session. */
  _userId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(offerId)) {
      return { success: false, error: "Invalid offer ID" };
    }

    const gate = await requireOfferActor(offerId);
    if (!gate.ok) return { success: false, error: gate.error };

    // Check current state
    const stateResult = await getOfferLifecycleState(offerId);
    if (!stateResult.success || !stateResult.data) {
      return { success: false, error: stateResult.error };
    }

    if (stateResult.data.current_state !== "DRAFT") {
      return { success: false, error: `Cannot submit offer in ${stateResult.data.current_state} state` };
    }

    // Emit submission event
    const supabase = createServiceClient();
    const { error } = await supabase.from("activities").insert({
      // From the OFFER, not from a caller-supplied user id.
      brokerage_id: gate.brokerageId,
      agent_id: await resolveAgentId(supabase as any, gate.userId),
      activity_type: "buyer.offer.submitted",
      title: `Offer submitted`,
      description: `Offer ${offerId} submitted`,
      notes: JSON.stringify({ offer_id: offerId, previous_state: "DRAFT", new_state: "PENDING" }),
      status: "completed",
      entity_type: "offer",
      entity_id: offerId,
    });

    if (error) throw error;

    return { success: true };
  } catch (error: any) {
    console.error("[System 7.1A] Error submitting offer:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Withdraw offer (DRAFT|PENDING → WITHDRAWN)
 *
 * GATED — same class as `submitOffer` above, with a sharper edge: `WITHDRAWN` is
 * a **terminal** state in this machine, so an unauthenticated caller could kill
 * any live offer on the platform outright and stamp an arbitrary `reason` onto
 * the audit trail. The tenant now comes from `offers.brokerage_id`.
 */
export async function withdrawOffer(
  offerId: string,
  /** Ignored — the actor is derived from the session. */
  _userId: string | undefined,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(offerId)) {
      return { success: false, error: "Invalid offer ID" };
    }

    const gate = await requireOfferActor(offerId);
    if (!gate.ok) return { success: false, error: gate.error };

    // Check current state
    const stateResult = await getOfferLifecycleState(offerId);
    if (!stateResult.success || !stateResult.data) {
      return { success: false, error: stateResult.error };
    }

    if (!["DRAFT", "PENDING"].includes(stateResult.data.current_state)) {
      return { success: false, error: `Cannot withdraw offer in ${stateResult.data.current_state} state` };
    }

    // Emit withdrawal event
    const supabase = createServiceClient();
    const { error } = await supabase.from("activities").insert({
      // From the OFFER, not from a caller-supplied user id.
      brokerage_id: gate.brokerageId,
      agent_id: await resolveAgentId(supabase as any, gate.userId),
      activity_type: "buyer.offer.withdrawn",
      title: `Offer withdrawn`,
      description: reason,
      notes: JSON.stringify({ offer_id: offerId, previous_state: stateResult.data.current_state, new_state: "WITHDRAWN", reason }),
      status: "completed",
      entity_type: "offer",
      entity_id: offerId,
    });

    if (error) throw error;

    return { success: true };
  } catch (error: any) {
    console.error("[System 7.1A] Error withdrawing offer:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Record seller response (PENDING → ACCEPTED|REJECTED|COUNTERED)
 *
 * GATED — this was the worst of the three. Unauthenticated, on the service
 * client, it let **anyone accept or reject any PENDING offer on the platform**
 * and file the resulting `buyer.offer.accepted` activity under a tenant of the
 * caller's choosing. `ACCEPTED` and `REJECTED` are terminal states here, and
 * `getOfferLifecycleState` — which this writes the source rows for — is what
 * `convert-to-transaction.ts` and `handle-multi-offer.ts` gate on, so a forged
 * acceptance propagates into the transaction lane.
 *
 * Note this is a *different* function from
 * `app/actions/buyer-offer/record-seller-response.ts:recordSellerResponse`, which
 * is the wired one the offer-agent-actions surface calls. This one is the
 * activities-derived lifecycle mirror; both are kept (see the "not a duplicate"
 * reasoning in the ledger) and this one is now gated to match.
 */
export async function recordSellerResponse(
  offerId: string,
  response: "ACCEPTED" | "REJECTED" | "COUNTERED",
  /** Ignored — the actor is derived from the session. */
  _userId?: string,
  notes?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(offerId)) {
      return { success: false, error: "Invalid offer ID" };
    }

    const gate = await requireOfferActor(offerId);
    if (!gate.ok) return { success: false, error: gate.error };

    // Check current state
    const stateResult = await getOfferLifecycleState(offerId);
    if (!stateResult.success || !stateResult.data) {
      return { success: false, error: stateResult.error };
    }

    if (stateResult.data.current_state !== "PENDING") {
      return { success: false, error: `Cannot record response for offer in ${stateResult.data.current_state} state` };
    }

    // Emit response event
    const supabase = createServiceClient();
    const eventType = `buyer.offer.${response.toLowerCase()}`;

    const { error } = await supabase.from("activities").insert({
      // From the OFFER, not from a caller-supplied user id.
      brokerage_id: gate.brokerageId,
      agent_id: await resolveAgentId(supabase as any, gate.userId),
      activity_type: eventType,
      title: `Seller response: ${response}`,
      description: notes ?? `Seller responded: ${response}`,
      notes: JSON.stringify({ offer_id: offerId, previous_state: "PENDING", new_state: response, response_type: response }),
      status: "completed",
      entity_type: "offer",
      entity_id: offerId,
    });

    if (error) throw error;

    return { success: true };
  } catch (error: any) {
    console.error("[System 7.1A] Error recording seller response:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Mark offer as expired (PENDING → EXPIRED)
 *
 * GATED, TENANT-SCOPED FROM THE OFFER, AND THE DEADLINE IS NOW ACTUALLY CHECKED.
 *
 * This is `"use server"`, so a public HTTP endpoint, and it authenticated
 * nothing while running on `createServiceClient()` — RLS not in play. Three
 * separate defects rode on that:
 *
 *  1. **Anyone could kill any live offer.** The only inputs were an offer uuid
 *     and a `systemUserId`, neither checked against a session. `EXPIRED` is a
 *     terminal state in this machine (`is_terminal`), so the buyer's offer —
 *     real money, a real deadline — became unrespondable, and
 *     `getOfferLifecycleState` is what `submitOffer`, `withdrawOffer`,
 *     `recordSellerResponse`, `canBuyerSubmitOffer` and the buyer-facing
 *     multi-offer banner all gate on.
 *  2. **The tenant of the audit row came from the caller.** `brokerage_id` was
 *     read off whatever `users` row the caller named, so the expiry event could
 *     be filed under a brokerage that has nothing to do with the offer — or
 *     under `null`, since `?? null` silently accepted a nonexistent user. It now
 *     comes from `offers.brokerage_id`, which is the only authority on which
 *     tenant the offer belongs to.
 *  3. **"deadline_passed" was asserted, never verified.** The notes payload has
 *     always claimed `expiration_reason: "deadline_passed"` without once looking
 *     at `offers.response_deadline`. An offer with three days left could be
 *     expired on the spot and the audit trail would say the deadline had passed.
 *     The check is now real: no deadline, or a deadline in the future, is a
 *     refusal.
 *
 * `systemUserId` is ignored — the actor is the session's user. The name says
 * "system", but a `"use server"` export is not a system channel; a scheduled job
 * that needs to run this without a session should call it through a route
 * handler holding a service credential, not by naming a user id over HTTP.
 */
export async function markOfferExpired(
  offerId: string,
  /** Ignored — the actor is derived from the session. */
  _systemUserId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(offerId)) {
      return { success: false, error: "Invalid offer ID" };
    }

    const gate = await requireOfferActor(offerId);
    if (!gate.ok) return { success: false, error: gate.error };

    // Deadline check, PENDING check, the activity write AND the offers.status
    // sync all live in lib/buyer-offer/expire-offers.ts so that the hourly
    // /api/cron/offer-expiry sweep — which has no session and must not fake one —
    // runs exactly this logic through its own service-credential door instead of
    // a divergent copy.
    const supabase = createServiceClient();
    const outcome = await expireOffer(supabase as any, {
      offerId,
      // From the OFFER, not from a caller-supplied user id.
      brokerageId: gate.brokerageId,
      responseDeadline: gate.responseDeadline,
      // IDENTITY CLASS. activities.agent_id FKs agents(id) and the session gives
      // a users id — they are disjoint spaces, so it is RESOLVED, never
      // substituted.
      actorAgentId: await resolveAgentId(supabase as any, gate.userId),
    });

    if (!outcome.expired) return { success: false, error: outcome.reason };

    return { success: true };
  } catch (error: any) {
    console.error("[System 7.1A] Error marking offer expired:", error);
    return { success: false, error: error.message };
  }
}

// DELETED: `deriveStateFromEvent(activityType)` — a private 7-entry
// activity_type → state map, and the 7-name `.in(...)` list that fed it.
// SURVIVOR: lib/buyer-offer/offer-lifecycle.ts:EVENT_TO_STATE (the map),
// lib/buyer-offer/offer-lifecycle.ts:OFFER_LIFECYCLE_EVENT_TYPES (the filter),
// applied by lib/buyer-offer/offer-lifecycle.ts:deriveOfferStateFromActivities.
// Nothing was merged onto the survivor from here: the survivor's table is a
// strict superset (14 events vs 7) over the identical key, and it returns
// `"UNKNOWN"` for nothing — an event with no state mapping is skipped rather
// than being allowed to become the current state.
