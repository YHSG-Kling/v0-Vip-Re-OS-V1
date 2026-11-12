/**
 * System 5.1C: Buyer Lifecycle Governance Core - Gating Helpers
 * 
 * Read-only helpers to check if buyer actions are allowed.
 * Gates search, tour, and offer eligibility based on lifecycle state.
 * 
 * This is GOVERNANCE ONLY - performs NO actions, only returns YES/NO
 */

import { isSystemGateEnabled, type BuyerState } from "./lifecycle-definitions"
import { checkFinancialVerification } from "./financial-verification"
import { getCurrentBuyerState } from "./lifecycle-logger"

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

// CONSOLIDATED AWAY — this file's private getCurrentBuyerState.
//
// It read `activities` where activity_type = 'buyer.lifecycle.transition'. NOTHING has ever
// written that row: the canonical writer, emitLifecycleTransition, routes through
// transitionLifecycle() into `lifecycle_events` with entity_type 'buyer_lifecycle'. Live
// census at removal: 0 rows matching the activity type, 8 real buyer_lifecycle rows in
// lifecycle_events — the state existed the whole time, in the other table.
//
// So this returned null for every buyer, always. And these gates FAIL CLOSED on null
// ("Buyer state not found"), which means isSearchAllowed / isTourAllowed / isOfferAllowed
// and the batch check denied EVERY buyer permanently. A governance layer that blocks
// everyone is not safe, it is broken — it cannot distinguish an unverified buyer from a
// fully verified one, so the gate carries no information at all.
//
// Named survivor: lib/buyer-lifecycle/lifecycle-logger.ts:getCurrentBuyerState — same
// signature, same return type, reads the table the writer actually writes. Nothing is
// lost; the local copy did strictly less.

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
