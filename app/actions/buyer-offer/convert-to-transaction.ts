"use server";

import { createServiceClient } from "@/lib/supabase/service";
import { isValidUUID } from "@/lib/validations";
import { getOfferLifecycleState } from "./track-offer-lifecycle";

/**
 * System 7.1A Domain 4: Transition to Transaction
 * Module: Convert Offer to Transaction
 * 
 * Converts ACCEPTED offer to transaction and:
 * 1. Creates transaction record
 * 2. Emits buyer.under_contract event (FREEZES buyer lifecycle)
 * 3. Emits listing.under_contract event (FREEZES listing lifecycle)
 * 4. Links offer to transaction
 * 
 * Per JOURNEY_PROGRESS_CONTRACT: Journey stops at *_UNDER_CONTRACT
 */

/**
 * Convert accepted offer to transaction
 */
export async function convertOfferToTransaction(
  offerId: string,
  userId: string,
  closingDate: string
): Promise<{ 
  success: boolean; 
  transaction_id?: string; 
  error?: string 
}> {
  try {
    if (!isValidUUID(offerId) || !isValidUUID(userId)) {
      return { success: false, error: "Invalid IDs" };
    }

    // 1. Verify offer is ACCEPTED
    const stateResult = await getOfferLifecycleState(offerId);
    if (!stateResult.success || !stateResult.data) {
      return { success: false, error: stateResult.error || "Could not get offer state" };
    }

    if (stateResult.data.current_state !== "ACCEPTED") {
      return { 
        success: false, 
        error: `Cannot convert ${stateResult.data.current_state} offer to transaction` 
      };
    }

    const supabase = createServiceClient();

    // 2. Get offer details
    const { data: offer, error: offerError } = await supabase
      .from("offers")
      .select("contact_id, listing_id, offer_price, earnest_money_amount")
      .eq("id", offerId)
      .single();

    if (offerError || !offer) {
      return { success: false, error: "Offer not found" };
    }

    // 3. Create transaction record
    const { data: transaction, error: transactionError } = await supabase
      .from("transactions")
      .insert({
        contact_id: offer.contact_id,
        listing_id: offer.listing_id,
        transaction_type: "purchase",
        status: "under_contract",
        sale_price: offer.offer_price,
        earnest_money: offer.earnest_money_amount,
        closing_date: closingDate,
        offer_id: offerId
      })
      .select()
      .single();

    if (transactionError || !transaction) {
      return { success: false, error: "Failed to create transaction" };
    }

    // 4. Emit buyer.under_contract event (FREEZES buyer lifecycle)
    await supabase.from("activities").insert({
      entity_type: "contact",
      entity_id: offer.contact_id,
      activity_type: "buyer_under_contract",
      event_type: "buyer.under_contract",
      user_id: userId,
      event_metadata: {
        transaction_id: transaction.id,
        listing_id: offer.listing_id,
        offer_id: offerId,
        closing_date: closingDate,
        sale_price: offer.offer_price,
        lifecycle_freeze: true, // Signal to System 5.1C
        timestamp: new Date().toISOString()
      }
    });

    // 5. Emit listing.under_contract event (FREEZES listing lifecycle)
    await supabase.from("activities").insert({
      entity_type: "listing",
      entity_id: offer.listing_id,
      activity_type: "listing_under_contract",
      event_type: "listing.under_contract",
      user_id: userId,
      event_metadata: {
        transaction_id: transaction.id,
        buyer_contact_id: offer.contact_id,
        offer_id: offerId,
        closing_date: closingDate,
        sale_price: offer.offer_price,
        lifecycle_freeze: true, // Signal to System 5.2
        timestamp: new Date().toISOString()
      }
    });

    // 6. Emit offer-to-transaction conversion event
    await supabase.from("activities").insert({
      entity_type: "offer",
      entity_id: offerId,
      activity_type: "offer_to_transaction",
      event_type: "buyer.offer.converted_to_transaction",
      user_id: userId,
      event_metadata: {
        transaction_id: transaction.id,
        conversion_timestamp: new Date().toISOString()
      }
    });

    return { 
      success: true, 
      transaction_id: transaction.id 
    };
  } catch (error: any) {
    console.error("[System 7.1A] Error converting offer to transaction:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Check if buyer/listing is frozen (under contract)
 */
export async function checkFrozenState(
  entityType: "contact" | "listing",
  entityId: string
): Promise<{ 
  success: boolean; 
  is_frozen: boolean; 
  transaction_id?: string;
  error?: string 
}> {
  try {
    if (!isValidUUID(entityId)) {
      return { success: false, is_frozen: false, error: "Invalid entity ID" };
    }

    const supabase = createServiceClient();

    const eventType = entityType === "contact" 
      ? "buyer.under_contract" 
      : "listing.under_contract";

    // Check for under_contract event
    const { data: events, error } = await supabase
      .from("activities")
      .select("event_metadata")
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .eq("event_type", eventType)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) throw error;

    if (events && events.length > 0) {
      return { 
        success: true, 
        is_frozen: true,
        transaction_id: events[0].event_metadata?.transaction_id
      };
    }

    return { success: true, is_frozen: false };
  } catch (error: any) {
    console.error("[System 7.1A] Error checking frozen state:", error);
    return { success: false, is_frozen: false, error: error.message };
  }
}
