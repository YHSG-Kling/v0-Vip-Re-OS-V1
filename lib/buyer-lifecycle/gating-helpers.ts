/**
 * System 5.1C: Buyer Lifecycle Governance Core - Gating Helpers
 * 
 * Read-only helpers to check if buyer actions are allowed.
 * Gates search, tour, and offer eligibility based on lifecycle state.
 * 
 * This is GOVERNANCE ONLY - performs NO actions, only returns YES/NO
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isSystemGateEnabled, type BuyerState } from "./lifecycle-definitions"
import { checkFinancialVerification } from "./financial-verification"

export interface GatingResult {
  allowed: boolean
  reason?: string
  currentState?: BuyerState
  requiredState?: string
  blockers?: string[]
}

/**
 * Check if buyer is allowed to search properties
 * 
 * Requirements:
 * - State must be BUYER_SEARCHING or later
 * - Financial verification required
 */
export async function isSearchAllowed(contactId: string): Promise<GatingResult> {
  const currentState = await getCurrentBuyerState(contactId)
  
  if (!currentState) {
    return {
      allowed: false,
      reason: "Buyer state not found",
      blockers: ["no_buyer_state"],
    }
  }
  
  // Check if property_search gate is enabled
  if (!isSystemGateEnabled(currentState, "property_search")) {
    return {
      allowed: false,
      reason: "Buyer must be financially verified and actively searching",
      currentState,
      requiredState: "BUYER_SEARCHING",
      blockers: ["lifecycle_gate_not_enabled"],
    }
  }
  
  // Check financial verification
  const verification = await checkFinancialVerification({ contactId })
  if (!verification.isVerified) {
    return {
      allowed: false,
      reason: "Financial verification required before property search",
      currentState,
      blockers: ["financial_verification_required"],
    }
  }
  
  return {
    allowed: true,
    currentState,
  }
}

/**
 * Check if buyer is allowed to schedule tours
 * 
 * Requirements:
 * - State must be BUYER_TOUR_ELIGIBLE or later
 * - Financial verification required
 */
export async function isTourAllowed(contactId: string): Promise<GatingResult> {
  const currentState = await getCurrentBuyerState(contactId)
  
  if (!currentState) {
    return {
      allowed: false,
      reason: "Buyer state not found",
      blockers: ["no_buyer_state"],
    }
  }
  
  // Check if tour_scheduling gate is enabled
  if (!isSystemGateEnabled(currentState, "tour_scheduling")) {
    return {
      allowed: false,
      reason: "Buyer must be tour eligible or actively touring",
      currentState,
      requiredState: "BUYER_TOUR_ELIGIBLE",
      blockers: ["lifecycle_gate_not_enabled"],
    }
  }
  
  // Check financial verification
  const verification = await checkFinancialVerification({ contactId })
  if (!verification.isVerified) {
    return {
      allowed: false,
      reason: "Financial verification required before scheduling tours",
      currentState,
      blockers: ["financial_verification_required"],
    }
  }
  
  return {
    allowed: true,
    currentState,
  }
}

/**
 * Check if buyer is allowed to submit offers
 * 
 * Requirements:
 * - State must be BUYER_OFFER_ELIGIBLE or later
 * - Financial verification required
 */
export async function isOfferAllowed(contactId: string): Promise<GatingResult> {
  const currentState = await getCurrentBuyerState(contactId)
  
  if (!currentState) {
    return {
      allowed: false,
      reason: "Buyer state not found",
      blockers: ["no_buyer_state"],
    }
  }
  
  // Check if offer_creation gate is enabled
  if (!isSystemGateEnabled(currentState, "offer_creation")) {
    return {
      allowed: false,
      reason: "Buyer must be offer eligible or have submitted offers",
      currentState,
      requiredState: "BUYER_OFFER_ELIGIBLE",
      blockers: ["lifecycle_gate_not_enabled"],
    }
  }
  
  // Check financial verification
  const verification = await checkFinancialVerification({ contactId })
  if (!verification.isVerified) {
    return {
      allowed: false,
      reason: "Financial verification required before submitting offers",
      currentState,
      blockers: ["financial_verification_required"],
    }
  }
  
  return {
    allowed: true,
    currentState,
  }
}

/**
 * Get current buyer state from most recent lifecycle transition event
 */
async function getCurrentBuyerState(contactId: string): Promise<BuyerState | null> {
  const supabase = createServiceClient()
  
  const { data: event, error } = await supabase
    .from("activities")
    .select("metadata")
    .eq("type", "buyer.lifecycle.transition")
    .eq("entity_type", "contact")
    .eq("entity_id", contactId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single()
  
  if (error || !event || !event.metadata) {
    return null
  }
  
  const metadata = event.metadata as Record<string, unknown>
  return (metadata.to_state as BuyerState) || null
}

/**
 * Batch check gating for multiple buyers
 */
export interface BulkGatingRequest {
  contactId: string
  gateType: "search" | "tour" | "offer"
}

export interface BulkGatingResult {
  allowed: Map<string, GatingResult>
  blocked: Map<string, GatingResult>
}

export async function batchCheckGating(
  requests: BulkGatingRequest[]
): Promise<BulkGatingResult> {
  const allowed = new Map<string, GatingResult>()
  const blocked = new Map<string, GatingResult>()
  
  const promises = requests.map(async (request) => {
    let result: GatingResult
    
    if (request.gateType === "search") {
      result = await isSearchAllowed(request.contactId)
    } else if (request.gateType === "tour") {
      result = await isTourAllowed(request.contactId)
    } else {
      result = await isOfferAllowed(request.contactId)
    }
    
    return { contactId: request.contactId, result }
  })
  
  const settled = await Promise.allSettled(promises)
  
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      const { contactId, result } = outcome.value
      if (result.allowed) {
        allowed.set(contactId, result)
      } else {
        blocked.set(contactId, result)
      }
    }
  }
  
  return { allowed, blocked }
}

/**
 * Get all system gates enabled for a buyer
 */
export async function getEnabledGatesForBuyer(
  contactId: string
): Promise<string[]> {
  const currentState = await getCurrentBuyerState(contactId)
  
  if (!currentState) {
    return []
  }
  
  const { getEnabledSystemGates } = require("./lifecycle-definitions")
  return getEnabledSystemGates(currentState)
}

/**
 * Check if specific gate is enabled for buyer
 */
export async function isGateEnabled(
  contactId: string,
  gateName: string
): Promise<boolean> {
  const currentState = await getCurrentBuyerState(contactId)
  
  if (!currentState) {
    return false
  }
  
  return isSystemGateEnabled(currentState, gateName)
}
