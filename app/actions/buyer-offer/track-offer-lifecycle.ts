"use server";

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveAgentId } from "@/lib/kernel/agent-identity"
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

export interface OfferLifecycleState {
  offer_id: string;
  current_state: "DRAFT" | "PENDING" | "ACCEPTED" | "REJECTED" | "COUNTERED" | "EXPIRED" | "WITHDRAWN";
  state_since: string;
  history: Array<{
    state: string;
    timestamp: string;
    actor_id: string;
    reason?: string;
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
 * Get current lifecycle state for an offer
 */
export async function getOfferLifecycleState(
  offerId: string
): Promise<{ success: boolean; data?: OfferLifecycleState; error?: string }> {
  try {
    if (!isValidUUID(offerId)) {
      return { success: false, error: "Invalid offer ID" };
    }

    const supabase = createServiceClient();

    // THE OFFER KEY. This read used to say `.eq("entity_type", "contact")` and
    // filter by NOTHING else — the offerId was never applied. It therefore
    // returned every buyer.offer.* activity in the entire database (service
    // client, so across all tenants), took the most recent one, and reported it
    // as "the current state of THIS offer". Every offer on the platform read
    // back the same state — whatever the last offer event anywhere happened to
    // be — and every caller that gates on this (submitOffer, withdrawOffer,
    // recordSellerResponse, markOfferExpired, canBuyerSubmitOffer,
    // checkDuplicateOffer, getBuyerActiveOffers, and the multi-offer banner the
    // buyer actually sees) inherited it.
    //
    // The canonical key is the one lib/buyer-offer/status-sync.ts already reads:
    // entity_type='offer' + entity_id=<offer id>. The writers below now stamp
    // it, which also means offers.status can finally sync — syncOfferStatus and
    // getCurrentOfferStatus query exactly this shape and so had never once
    // matched a row written by this file.
    const { data: events, error } = await supabase
      .from("activities")
      .select("activity_type, notes, created_at, agent_id")
      .eq("entity_type", "offer")
      .eq("entity_id", offerId)
      .in("activity_type", [
        "buyer.offer.draft.created",
        "buyer.offer.submitted",
        "buyer.offer.accepted",
        "buyer.offer.rejected",
        "buyer.offer.countered",
        "buyer.offer.expired",
        "buyer.offer.withdrawn"
      ])
      .order("created_at", { ascending: true });

    if (error) throw error;

    if (!events || events.length === 0) {
      return { success: false, error: "Offer not found" };
    }

    // Derive current state from events
    const history = events.map(e => {
      let parsedNotes: Record<string, any> = {}
      try { parsedNotes = e.notes ? JSON.parse(e.notes) : {} } catch { /* ignore */ }
      return {
        state: deriveStateFromEvent(e.activity_type),
        timestamp: e.created_at,
        actor_id: e.agent_id,
        reason: parsedNotes?.reason
      }
    });

    const currentState = history[history.length - 1];

    const lifecycleState: OfferLifecycleState = {
      offer_id: offerId,
      current_state: currentState.state as any,
      state_since: currentState.timestamp,
      history,
      is_terminal: ["ACCEPTED", "REJECTED", "EXPIRED", "WITHDRAWN"].includes(currentState.state)
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

    // The reason recorded has to be the reason that happened.
    if (!gate.responseDeadline) {
      return { success: false, error: "This offer has no response deadline, so it cannot expire on one" };
    }
    if (new Date(gate.responseDeadline).getTime() > Date.now()) {
      return { success: false, error: "The response deadline has not passed yet" };
    }

    // Check current state
    const stateResult = await getOfferLifecycleState(offerId);
    if (!stateResult.success || !stateResult.data) {
      return { success: false, error: stateResult.error };
    }

    if (stateResult.data.current_state !== "PENDING") {
      return { success: false, error: "Only PENDING offers can expire" };
    }

    // Emit expiration event
    const supabase = createServiceClient();
    const { error } = await supabase.from("activities").insert({
      // From the OFFER, not from a caller-supplied user id.
      brokerage_id: gate.brokerageId,
      // IDENTITY CLASS. activities.agent_id FKs agents(id) and the session gives
      // a users id — they are disjoint spaces, so it is RESOLVED, never
      // substituted. The three sibling writes in this file (submitted,
      // withdrawn, response) already resolve it; this fourth one was missed, so
      // every EXPIRED offer failed to record its lifecycle event while the other
      // three recorded fine.
      agent_id: await resolveAgentId(supabase as any, gate.userId),
      activity_type: "buyer.offer.expired",
      title: "Offer expired",
      description: "Offer expired: deadline passed",
      notes: JSON.stringify({
        offer_id: offerId,
        previous_state: "PENDING",
        new_state: "EXPIRED",
        expiration_reason: "deadline_passed",
        response_deadline: gate.responseDeadline,
      }),
      status: "completed",
      entity_type: "offer",
      entity_id: offerId,
    });

    if (error) throw error;

    return { success: true };
  } catch (error: any) {
    console.error("[System 7.1A] Error marking offer expired:", error);
    return { success: false, error: error.message };
  }
}

// Helper: Derive state from activity_type
function deriveStateFromEvent(activityType: string): string {
  const mapping: Record<string, string> = {
    "buyer.offer.draft.created": "DRAFT",
    "buyer.offer.submitted": "PENDING",
    "buyer.offer.accepted": "ACCEPTED",
    "buyer.offer.rejected": "REJECTED",
    "buyer.offer.countered": "COUNTERED",
    "buyer.offer.expired": "EXPIRED",
    "buyer.offer.withdrawn": "WITHDRAWN"
  };
  return mapping[activityType] || "UNKNOWN";
}
