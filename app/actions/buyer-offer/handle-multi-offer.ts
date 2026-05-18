"use server";

import { createServiceClient } from "@/lib/supabase/service";
import { isValidUUID } from "@/lib/validations";
import { getOfferLifecycleState } from "./track-offer-lifecycle";

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
 */

const MAX_PENDING_OFFERS = 3;

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

    if (pendingCount >= MAX_PENDING_OFFERS) {
      return {
        success: true,
        can_submit: false,
        reason: `Maximum ${MAX_PENDING_OFFERS} pending offers reached`,
        pending_count: pendingCount
      };
    }

    return {
      success: true,
      can_submit: true,
      pending_count: pendingCount
    };
  } catch (error: any) {
    console.error("[System 7.1A] Error checking multi-offer eligibility:", error);
    return { success: false, can_submit: false, reason: error.message };
  }
}

/**
 * Check for duplicate offer on same listing
 */
export async function checkDuplicateOffer(
  contactId: string,
  listingId: string
): Promise<{ 
  success: boolean; 
  has_duplicate: boolean; 
  existing_offer_id?: string;
  existing_state?: string;
}> {
  try {
    if (!isValidUUID(contactId) || !isValidUUID(listingId)) {
      return { success: false, has_duplicate: false };
    }

    const supabase = createServiceClient();

    // Find existing offers for this buyer on this listing
    const { data: offers, error } = await supabase
      .from("offers")
      .select("id")
      .eq("contact_id", contactId)
      .eq("listing_id", listingId);

    if (error) throw error;

    if (!offers || offers.length === 0) {
      return { success: true, has_duplicate: false };
    }

    // Check if any are still active (not terminal)
    for (const offer of offers) {
      const stateResult = await getOfferLifecycleState(offer.id);
      if (stateResult.success && stateResult.data && !stateResult.data.is_terminal) {
        return {
          success: true,
          has_duplicate: true,
          existing_offer_id: offer.id,
          existing_state: stateResult.data.current_state
        };
      }
    }

    return { success: true, has_duplicate: false };
  } catch (error: any) {
    console.error("[System 7.1A] Error checking duplicate offer:", error);
    return { success: false, has_duplicate: false };
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
    // multi_offer signals against any contact's activity log.
    const { createClient } = await import("@/lib/supabase/server")
    const authClient = await createClient()
    const { data: { user: authUser } } = await authClient.auth.getUser()
    if (!authUser) return { success: false, error: "Unauthorized" }
    const { data: callerRow } = await authClient
      .from("users")
      .select("brokerage_id")
      .eq("id", authUser.id)
      .maybeSingle()
    if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }

    const supabase = createServiceClient();

    // Verify contact belongs to caller's brokerage
    const { data: contact } = await supabase
      .from("contacts")
      .select("brokerage_id")
      .eq("id", contactId)
      .maybeSingle()
    if (!contact) return { success: false, error: "Contact not found" }
    if (contact.brokerage_id !== callerRow.brokerage_id) {
      return { success: false, error: "Forbidden" }
    }

    const { error } = await supabase.from("activities").insert({
      brokerage_id: callerRow.brokerage_id,
      entity_type: "contact",
      entity_id: contactId,
      activity_type: "multi_offer_signal",
      event_type: `buyer.offer.${eventType}`,
      event_metadata: {
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
