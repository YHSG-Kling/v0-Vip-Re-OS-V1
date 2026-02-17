"use server";

import { createServiceClient } from "@/lib/supabase/service";
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

    // Get all lifecycle events for this offer
    const { data: events, error } = await supabase
      .from("activities")
      .select("event_type, event_metadata, created_at, user_id")
      .eq("entity_type", "offer")
      .eq("entity_id", offerId)
      .in("event_type", [
        "buyer.offer.draft_created",
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
    const history = events.map(e => ({
      state: deriveStateFromEvent(e.event_type),
      timestamp: e.created_at,
      actor_id: e.user_id,
      reason: e.event_metadata?.reason
    }));

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
 */
export async function submitOffer(
  offerId: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(offerId) || !isValidUUID(userId)) {
      return { success: false, error: "Invalid IDs" };
    }

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
      entity_type: "offer",
      entity_id: offerId,
      activity_type: "offer_submission",
      event_type: "buyer.offer.submitted",
      user_id: userId,
      event_metadata: {
        previous_state: "DRAFT",
        new_state: "PENDING",
        submitted_at: new Date().toISOString()
      }
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
 */
export async function withdrawOffer(
  offerId: string,
  userId: string,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(offerId) || !isValidUUID(userId)) {
      return { success: false, error: "Invalid IDs" };
    }

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
      entity_type: "offer",
      entity_id: offerId,
      activity_type: "offer_withdrawal",
      event_type: "buyer.offer.withdrawn",
      user_id: userId,
      event_metadata: {
        previous_state: stateResult.data.current_state,
        new_state: "WITHDRAWN",
        reason,
        withdrawn_at: new Date().toISOString()
      }
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
 */
export async function recordSellerResponse(
  offerId: string,
  response: "ACCEPTED" | "REJECTED" | "COUNTERED",
  userId: string,
  notes?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(offerId) || !isValidUUID(userId)) {
      return { success: false, error: "Invalid IDs" };
    }

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
      entity_type: "offer",
      entity_id: offerId,
      activity_type: "seller_response",
      event_type: eventType,
      user_id: userId,
      event_metadata: {
        previous_state: "PENDING",
        new_state: response,
        response_type: response,
        notes,
        responded_at: new Date().toISOString()
      }
    });

    if (error) throw error;

    return { success: true };
  } catch (error: any) {
    console.error("[System 7.1A] Error recording seller response:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Mark offer as expired
 */
export async function markOfferExpired(
  offerId: string,
  systemUserId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(offerId)) {
      return { success: false, error: "Invalid offer ID" };
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
      entity_type: "offer",
      entity_id: offerId,
      activity_type: "offer_expiration",
      event_type: "buyer.offer.expired",
      user_id: systemUserId,
      event_metadata: {
        previous_state: "PENDING",
        new_state: "EXPIRED",
        expired_at: new Date().toISOString(),
        expiration_reason: "deadline_passed"
      }
    });

    if (error) throw error;

    return { success: true };
  } catch (error: any) {
    console.error("[System 7.1A] Error marking offer expired:", error);
    return { success: false, error: error.message };
  }
}

// Helper: Derive state from event type
function deriveStateFromEvent(eventType: string): string {
  const mapping: Record<string, string> = {
    "buyer.offer.draft_created": "DRAFT",
    "buyer.offer.submitted": "PENDING",
    "buyer.offer.accepted": "ACCEPTED",
    "buyer.offer.rejected": "REJECTED",
    "buyer.offer.countered": "COUNTERED",
    "buyer.offer.expired": "EXPIRED",
    "buyer.offer.withdrawn": "WITHDRAWN"
  };
  return mapping[eventType] || "UNKNOWN";
}
