"use server"

/**
 * System 7.1A - Buyer Offer Execution Engine
 * Domain 2: Dotloop Loop Creation
 *
 * Creates Dotloop loop for buyer offer with proper state package
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { logActivity } from "@/app/actions/activities"

const DOTLOOP_API_BASE = "https://api-gateway.dotloop.com/public/v2"

export interface CreateDotloopLoopParams {
  offerId: string
  buyerId: string
  propertyAddress: string
  state: string // e.g. "CA", "TX"
  userId: string
  /** Required by logActivity — must come from contacts row, not user.id */
  brokerageId: string
  /** Agent who initiated the offer flow */
  agentId: string
  transactionId?: string
}

export interface CreateDotloopLoopResult {
  success: boolean
  loopId?: string
  error?: string
  errorCode?: string
}

/**
 * Create Dotloop loop for buyer offer
 */
export async function createDotloopLoopForOffer(
  params: CreateDotloopLoopParams
): Promise<CreateDotloopLoopResult> {
  const {
    offerId,
    buyerId,
    propertyAddress,
    state,
    userId,
    brokerageId,
    agentId,
    transactionId,
  } = params

  // Validate inputs
  if (!isValidUUID(buyerId)) {
    return { success: false, error: "Invalid buyer ID", errorCode: "invalid_buyer_id" }
  }
  if (!brokerageId) {
    return { success: false, error: "brokerageId is required", errorCode: "missing_brokerage_id" }
  }
  if (!agentId) {
    return { success: false, error: "agentId is required", errorCode: "missing_agent_id" }
  }

  const DOTLOOP_API_KEY = process.env.DOTLOOP_API_KEY
  const DOTLOOP_PROFILE_ID = process.env.DOTLOOP_PROFILE_ID

  if (!DOTLOOP_API_KEY || !DOTLOOP_PROFILE_ID) {
    // Fallback mode — emit manual required event
    await logActivity({
      brokerageId,
      agentId,
      contactId: buyerId,
      transactionId: transactionId ?? undefined,
      activityType: "buyer_offer_manual_dotloop_required",
      title: "Dotloop Manual Setup Required",
      description: `Dotloop API not configured — manual setup required for ${propertyAddress ?? "transaction"}`,
      notes: JSON.stringify({
        provider: "dotloop",
        offer_id: offerId,
        reason: "dotloop_api_unavailable",
        property_address: propertyAddress,
      }),
      entityType: "transaction",
      status: "completed",
    })

    return {
      success: false,
      error: "Dotloop API not configured - manual setup required",
      errorCode: "dotloop_not_configured",
    }
  }

  try {
    // Create Dotloop loop
    const response = await fetch(`${DOTLOOP_API_BASE}/profile/${DOTLOOP_PROFILE_ID}/loop`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DOTLOOP_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `Buyer Offer - ${propertyAddress}`,
        status: "Active",
        transaction_type: "Purchase",
        street_address: propertyAddress,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error("[buyer-offer] Dotloop API error:", errorText)

      // Emit fallback event
      await logActivity({
        brokerageId,
        agentId,
        contactId: buyerId,
        transactionId: transactionId ?? undefined,
        activityType: "buyer_offer_manual_dotloop_required",
        title: "Dotloop Manual Setup Required",
        description: `Dotloop API error — manual setup required for ${propertyAddress ?? "transaction"}`,
        notes: JSON.stringify({
          provider: "dotloop",
          offer_id: offerId,
          reason: "dotloop_api_error",
          api_error: errorText,
        }),
        entityType: "transaction",
        status: "completed",
      })

      return {
        success: false,
        error: `Dotloop API error: ${response.statusText}`,
        errorCode: "dotloop_api_error",
      }
    }

    const result = await response.json()
    const loopId = result.data?.loop_id

    if (!loopId) {
      await logActivity({
        brokerageId,
        agentId,
        contactId: buyerId,
        transactionId: transactionId ?? undefined,
        activityType: "buyer_offer_manual_dotloop_required",
        title: "Dotloop Manual Setup Required",
        description: "No loop ID returned from Dotloop — manual setup required",
        notes: JSON.stringify({
          provider: "dotloop",
          offer_id: offerId,
          reason: "no_loop_id_returned",
        }),
        entityType: "transaction",
        status: "completed",
      })

      return {
        success: false,
        error: "No loop ID returned from Dotloop",
        errorCode: "no_loop_id",
      }
    }

    // Emit success event — loopId stored in notes JSON for lookup
    await logActivity({
      brokerageId,
      agentId,
      contactId: buyerId,
      transactionId: transactionId ?? undefined,
      activityType: "dotloop_loop_created",
      title: "Dotloop Loop Created",
      description: `Dotloop loop created for ${propertyAddress ?? "transaction"}`,
      notes: JSON.stringify({
        provider: "dotloop",
        loopId,
        loopName: `Buyer Offer - ${propertyAddress}`,
        offer_id: offerId,
        state,
        brokerage_package_version: "v1.0",
      }),
      entityType: "transaction",
      status: "completed",
    })

    return {
      success: true,
      loopId,
    }
  } catch (error: any) {
    console.error("[buyer-offer] Error creating Dotloop loop:", error)

    // Emit fallback event
    await logActivity({
      brokerageId,
      agentId,
      contactId: buyerId,
      transactionId: transactionId ?? undefined,
      activityType: "buyer_offer_manual_dotloop_required",
      title: "Dotloop Manual Setup Required",
      description: "Exception during Dotloop loop creation — manual setup required",
      notes: JSON.stringify({
        provider: "dotloop",
        offer_id: offerId,
        reason: "exception",
        error_message: error.message,
      }),
      entityType: "transaction",
      status: "completed",
    })

    return {
      success: false,
      error: error.message,
      errorCode: "exception",
    }
  }
}

/**
 * Get Dotloop loop ID for offer.
 * Looks up via notes JSON — metadata column does not exist in activities.
 */
export async function getDotloopLoopIdForOffer(
  offerId: string,
  buyerId: string
): Promise<string | null> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from("activities")
    .select("notes")
    .eq("contact_id", buyerId)
    .eq("entity_type", "transaction")
    .eq("activity_type", "dotloop_loop_created")
    .order("created_at", { ascending: false })
    .limit(20)

  const match = (data ?? []).find((row: any) => {
    try {
      return JSON.parse(row.notes || "{}")?.offer_id === offerId
    } catch {
      return false
    }
  })

  if (!match?.notes) return null
  try {
    return JSON.parse(match.notes)?.loopId ?? null
  } catch {
    return null
  }
}
