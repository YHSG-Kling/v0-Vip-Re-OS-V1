"use server";

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { isValidUUID } from "@/lib/validations";
import { getOfferLifecycleState } from "./track-offer-lifecycle";
import { validateAcceptanceEligibility } from "@/lib/buyer-offer";
import { createTransactionFromOffer } from "@/lib/transactions";

/**
 * System 7.1A Domain 4: Transition to Transaction
 * Module: Convert Offer to Transaction
 * 
 * Converts ACCEPTED offer to transaction via offer-bridge.ts (single source of truth)
 * Enforces:
 * 1. Compliance gate validation
 * 2. contract_date requirement
 * 3. ACCEPTED state verification
 * 
 * Per JOURNEY_PROGRESS_CONTRACT: Journey stops at *_UNDER_CONTRACT
 */

/**
 * Convert accepted offer to transaction
 */
export async function convertOfferToTransaction(
  offerId: string,
  _userId: string,  // ignored — derived from session
  closingDate: string,
  contractDate: string,
  contractTerms?: {
    earnestMoneyDue?: string
    inspectionDeadline?: string
    appraisalDeadline?: string
    financingDeadline?: string
  }
): Promise<{
  success: boolean;
  transaction_id?: string;
  error?: string
}> {
  try {
    if (!isValidUUID(offerId)) {
      return { success: false, error: "Invalid offer ID" };
    }

    // Auth gate — previously trusted caller-supplied userId
    const authClient = await createClient();
    const { data: { user: authUser } } = await authClient.auth.getUser();
    if (!authUser) return { success: false, error: "Unauthorized" };
    const { data: callerRow } = await authClient
      .from("users")
      .select("brokerage_id")
      .eq("id", authUser.id)
      .maybeSingle();
    if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" };

    // 1. Verify compliance gate passed
    try {
      await validateAcceptanceEligibility(offerId);
    } catch (error: any) {
      return { success: false, error: error.message };
    }

    // 2. Verify offer is ACCEPTED
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

    // 3. Validate contract_date provided
    if (!contractDate) {
      return { success: false, error: "contract_date required to create transaction" };
    }

    const supabase = createServiceClient();

    // 4. Get offer details for brokerage_id (from canonical offers table)
    const { data: offer, error: offerError } = await supabase
      .from("offers")
      .select("brokerage_id, agent_id")
      .eq("id", offerId)
      .single();

    if (offerError || !offer) {
      return { success: false, error: "Offer not found" };
    }

    const brokerageId = offer.brokerage_id;
    if (!brokerageId) {
      return { success: false, error: "Brokerage ID not found for offer" };
    }

    // Verify offer belongs to caller's brokerage
    if (brokerageId !== callerRow.brokerage_id) {
      return { success: false, error: "Forbidden" };
    }

    // 5. Get compliance passed timestamp
    const { data: complianceEvent } = await supabase
      .from("activities")
      .select("created_at")
      .eq("entity_type", "offer")
      .eq("entity_id", offerId)
      .eq("activity_type", "buyer.offer.compliance.passed")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!complianceEvent) {
      return { success: false, error: "Compliance passed event not found" };
    }

    // 6. Call offer-bridge.ts (single source of truth for transaction creation)
    const result = await createTransactionFromOffer({
      offerId,
      brokerageId,
      contractDate,
      compliancePassedAt: complianceEvent.created_at,
      contractTerms: {
        earnestMoneyDue: contractTerms?.earnestMoneyDue,
        inspectionDeadline: contractTerms?.inspectionDeadline,
        appraisalDeadline: contractTerms?.appraisalDeadline,
        financingDeadline: contractTerms?.financingDeadline,
        closingDate
      }
    });

    return { 
      success: result.success, 
      transaction_id: result.transactionId,
      error: result.success ? undefined : "Failed to create transaction via offer-bridge"
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
