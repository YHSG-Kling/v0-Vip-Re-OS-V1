/**
 * System 5.3: CMA & Listing Presentation Governance Engine
 * Server Actions (Public API)
 * 
 * Provides server actions for:
 * - Decision state evaluation
 * - CMA quality checking
 * - Net sheet validity checking
 * - Presentation readiness
 * - Decision reversal validation
 * - Event logging
 * 
 * This is GOVERNANCE ONLY - no execution logic
 */

"use server"

import { evaluateDecisionReadiness, isDecisionReady, validateDecisionReversal } from "@/lib/seller-decision-governance/decision-readiness-engine"
import { evaluateCMAQuality, deriveCMAQualityFromEvents, isCMAReady } from "@/lib/seller-decision-governance/cma-quality-evaluator"
import { validateNetSheetValidity, deriveNetSheetValidityFromEvents, isNetSheetValid, emitNetSheetExpirationWarning } from "@/lib/seller-decision-governance/net-sheet-validator"
import { evaluatePresentationReadiness, derivePresentationReadinessFromEvents, isPresentationReady } from "@/lib/seller-decision-governance/presentation-readiness"
import { logDecisionTransition, logCMAQualityVerified, logNetSheetEvent, logPresentationEvent, logDecisionReversal, queryDecisionHistory } from "@/lib/seller-decision-governance/decision-logger"
import { getAllStates, getMilestoneStates, getStateDefinition, type SellerDecisionState } from "@/lib/seller-decision-governance/decision-state-definitions"
import { isValidUUID } from "@/lib/validations"

/**
 * Evaluate if listing is ready for a target decision state
 */
export async function evaluateSellerDecisionReadiness(input: {
  listingId: string
  targetState: SellerDecisionState
  overrideByRole?: "agent" | "team_leader" | "broker" | "admin"
  overrideReason?: string
}) {
  try {
    if (!isValidUUID(input.listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    const result = await evaluateDecisionReadiness(input)
    
    return {
      success: true,
      data: result,
    }
  } catch (error) {
    console.error("[v0] Error evaluating decision readiness:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Check if seller decision is ready (quick check for DECISION_READY state)
 */
export async function checkSellerDecisionReady(listingId: string) {
  try {
    if (!isValidUUID(listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    const ready = await isDecisionReady(listingId)
    
    return {
      success: true,
      data: { isReady: ready },
    }
  } catch (error) {
    console.error("[v0] Error checking decision ready:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Evaluate CMA quality
 */
export async function evaluateListingCMAQuality(input: {
  listingId: string
  comparableCount?: number
  oldestComparableMonths?: number
  maxRadiusMiles?: number
  agentApproved?: boolean
  brokerApproved?: boolean
  overrideByRole?: "agent" | "team_leader" | "broker" | "admin"
  overrideReason?: string
}) {
  try {
    if (!isValidUUID(input.listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    // If no CMA data provided, derive from events
    let cmaInput = input
    if (!input.comparableCount) {
      const derived = await deriveCMAQualityFromEvents(input.listingId)
      if (derived) {
        cmaInput = { ...input, ...derived }
      }
    }
    
    const result = await evaluateCMAQuality(cmaInput)
    
    return {
      success: true,
      data: result,
    }
  } catch (error) {
    console.error("[v0] Error evaluating CMA quality:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Check if CMA is ready (quick check)
 */
export async function checkCMAReady(listingId: string) {
  try {
    if (!isValidUUID(listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    const ready = await isCMAReady(listingId)
    
    return {
      success: true,
      data: { isReady: ready },
    }
  } catch (error) {
    console.error("[v0] Error checking CMA ready:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Validate net sheet validity
 */
export async function validateListingNetSheetValidity(input: {
  listingId: string
  generatedAt?: Date
  validityDays?: number
  overrideByRole?: "agent" | "team_leader" | "broker" | "admin"
  overrideReason?: string
}) {
  try {
    if (!isValidUUID(input.listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    // If no net sheet data provided, derive from events
    let netSheetInput = input
    if (!input.generatedAt) {
      const derived = await deriveNetSheetValidityFromEvents(input.listingId)
      if (derived) {
        netSheetInput = { ...input, ...derived }
      }
    }
    
    const result = validateNetSheetValidity(netSheetInput)
    
    // Emit expiration warning if needed
    if (result.isValid && result.daysRemaining <= 7) {
      await emitNetSheetExpirationWarning(input.listingId, result.daysRemaining)
    }
    
    return {
      success: true,
      data: result,
    }
  } catch (error) {
    console.error("[v0] Error validating net sheet:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Check if net sheet is valid (quick check)
 */
export async function checkNetSheetValid(listingId: string) {
  try {
    if (!isValidUUID(listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    const valid = await isNetSheetValid(listingId)
    
    return {
      success: true,
      data: { isValid: valid },
    }
  } catch (error) {
    console.error("[v0] Error checking net sheet validity:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Evaluate presentation readiness
 */
export async function evaluateListingPresentationReadiness(listingId: string) {
  try {
    if (!isValidUUID(listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    const input = await derivePresentationReadinessFromEvents(listingId)
    if (!input) {
      return {
        success: false,
        error: "No presentation data found",
      }
    }
    
    const result = evaluatePresentationReadiness(input)
    
    return {
      success: true,
      data: result,
    }
  } catch (error) {
    console.error("[v0] Error evaluating presentation readiness:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Check if presentation is ready (quick check)
 */
export async function checkPresentationReady(listingId: string) {
  try {
    if (!isValidUUID(listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    const ready = await isPresentationReady(listingId)
    
    return {
      success: true,
      data: { isReady: ready },
    }
  } catch (error) {
    console.error("[v0] Error checking presentation ready:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Validate decision reversal
 */
export async function validateSellerDecisionReversal(input: {
  listingId: string
  currentDecisionState: SellerDecisionState
  currentListingStage: string
}) {
  try {
    if (!isValidUUID(input.listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    const result = validateDecisionReversal(
      input.currentDecisionState,
      input.currentListingStage
    )
    
    return {
      success: true,
      data: result,
    }
  } catch (error) {
    console.error("[v0] Error validating decision reversal:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Log decision state transition
 */
export async function logSellerDecisionTransition(input: {
  listing_id: string
  from_state?: SellerDecisionState
  to_state: SellerDecisionState
  authority_role: "agent" | "team_leader" | "broker" | "admin"
  override_flag?: boolean
  override_reason?: string
  metadata?: Record<string, any>
}) {
  try {
    if (!isValidUUID(input.listing_id)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    await logDecisionTransition(input)
    
    return { success: true }
  } catch (error) {
    console.error("[v0] Error logging decision transition:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Log CMA quality verification
 */
export async function logCMAQuality(input: {
  listing_id: string
  comparable_count: number
  oldest_comparable_months: number
  max_radius_miles: number
  quality_score: number
  approved_by_role: string
  metadata?: Record<string, any>
}) {
  try {
    if (!isValidUUID(input.listing_id)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    await logCMAQualityVerified(input)
    
    return { success: true }
  } catch (error) {
    console.error("[v0] Error logging CMA quality:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Log net sheet event
 */
export async function logNetSheetActivity(input: {
  listing_id: string
  event_type: "generated" | "expired" | "expiration_warning" | "regenerated"
  days_remaining?: number
  validity_days?: number
  metadata?: Record<string, any>
}) {
  try {
    if (!isValidUUID(input.listing_id)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    await logNetSheetEvent(input)
    
    return { success: true }
  } catch (error) {
    console.error("[v0] Error logging net sheet event:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Log presentation event
 */
export async function logPresentationActivity(input: {
  listing_id: string
  event_type: "assembled" | "video_ready" | "drip_started" | "drip_paused"
  metadata?: Record<string, any>
}) {
  try {
    if (!isValidUUID(input.listing_id)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    await logPresentationEvent(input)
    
    return { success: true }
  } catch (error) {
    console.error("[v0] Error logging presentation event:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Log decision reversal
 */
export async function logSellerDecisionReversal(input: {
  listing_id: string
  from_state: SellerDecisionState
  reversal_reason: string
  authority_role: string
  metadata?: Record<string, any>
}) {
  try {
    if (!isValidUUID(input.listing_id)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    await logDecisionReversal(input)
    
    return { success: true }
  } catch (error) {
    console.error("[v0] Error logging decision reversal:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Query decision history for a listing
 */
export async function getSellerDecisionHistory(listingId: string, limit = 50) {
  try {
    if (!isValidUUID(listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }
    
    const history = await queryDecisionHistory(listingId, limit)
    
    return {
      success: true,
      data: history,
    }
  } catch (error) {
    console.error("[v0] Error querying decision history:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Get all decision state definitions
 */
export async function getSellerDecisionStates() {
  try {
    const states = getAllStates()
    
    return {
      success: true,
      data: states,
    }
  } catch (error) {
    console.error("[v0] Error getting decision states:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Get milestone decision states
 */
export async function getMilestoneDecisionStates() {
  try {
    const states = getMilestoneStates()
    
    return {
      success: true,
      data: states,
    }
  } catch (error) {
    console.error("[v0] Error getting milestone states:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Get state definition
 */
export async function getDecisionStateDefinition(state: SellerDecisionState) {
  try {
    const definition = getStateDefinition(state)
    
    if (!definition) {
      return { success: false, error: "State not found" }
    }
    
    return {
      success: true,
      data: definition,
    }
  } catch (error) {
    console.error("[v0] Error getting state definition:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}
