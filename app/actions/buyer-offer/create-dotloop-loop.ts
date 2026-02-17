"use server"

/**
 * System 7.1A - Buyer Offer Execution Engine
 * Domain 2: Dotloop Loop Creation
 * 
 * Creates Dotloop loop for buyer offer with proper state package
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"

const DOTLOOP_API_BASE = "https://api-gateway.dotloop.com/public/v2"

export interface CreateDotloopLoopParams {
  offerId: string
  buyerId: string
  propertyAddress: string
  state: string // e.g. "CA", "TX"
  userId: string
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
  const { offerId, buyerId, propertyAddress, state, userId } = params

  // Validate inputs
  if (!isValidUUID(buyerId)) {
    return { success: false, error: "Invalid buyer ID", errorCode: "invalid_buyer_id" }
  }

  const DOTLOOP_API_KEY = process.env.DOTLOOP_API_KEY
  const DOTLOOP_PROFILE_ID = process.env.DOTLOOP_PROFILE_ID

  if (!DOTLOOP_API_KEY || !DOTLOOP_PROFILE_ID) {
    // Fallback mode - emit manual required event
    const supabase = createServiceClient()
    await supabase.from("activities").insert({
      type: "buyer.offer.manual_dotloop_required",
      entity_type: "contact",
      entity_id: buyerId,
      user_id: userId,
      metadata: {
        offer_id: offerId,
        reason: "dotloop_api_unavailable",
        property_address: propertyAddress,
      },
    })

    return {
      success: false,
      error: "Dotloop API not configured - manual setup required",
      errorCode: "dotloop_not_configured",
    }
  }

  const supabase = createServiceClient()

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
      await supabase.from("activities").insert({
        type: "buyer.offer.manual_dotloop_required",
        entity_type: "contact",
        entity_id: buyerId,
        user_id: userId,
        metadata: {
          offer_id: offerId,
          reason: "dotloop_api_error",
          api_error: errorText,
        },
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
      await supabase.from("activities").insert({
        type: "buyer.offer.manual_dotloop_required",
        entity_type: "contact",
        entity_id: buyerId,
        user_id: userId,
        metadata: {
          offer_id: offerId,
          reason: "no_loop_id_returned",
        },
      })

      return {
        success: false,
        error: "No loop ID returned from Dotloop",
        errorCode: "no_loop_id",
      }
    }

    // Emit success event
    await supabase.from("activities").insert({
      type: "buyer.offer.dotloop.loop.created",
      entity_type: "contact",
      entity_id: buyerId,
      user_id: userId,
      metadata: {
        offer_id: offerId,
        dotloop_loop_id: loopId,
        state,
        brokerage_package_version: "v1.0",
      },
    })

    return {
      success: true,
      loopId,
    }
  } catch (error: any) {
    console.error("[buyer-offer] Error creating Dotloop loop:", error)

    // Emit fallback event
    await supabase.from("activities").insert({
      type: "buyer.offer.manual_dotloop_required",
      entity_type: "contact",
      entity_id: buyerId,
      user_id: userId,
      metadata: {
        offer_id: offerId,
        reason: "exception",
        error_message: error.message,
      },
    })

    return {
      success: false,
      error: error.message,
      errorCode: "exception",
    }
  }
}

/**
 * Get Dotloop loop ID for offer
 */
export async function getDotloopLoopIdForOffer(
  offerId: string,
  buyerId: string
): Promise<string | null> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from("activities")
    .select("metadata")
    .eq("entity_type", "contact")
    .eq("entity_id", buyerId)
    .eq("type", "buyer.offer.dotloop.loop.created")
    .eq("metadata->offer_id", offerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data?.metadata) return null

  const metadata = data.metadata as { dotloop_loop_id?: string }
  return metadata.dotloop_loop_id || null
}
