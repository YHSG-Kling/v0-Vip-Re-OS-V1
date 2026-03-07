/**
 * System 5.3: CMA & Listing Presentation Governance Engine
 * Decision Readiness Engine
 * 
 * Orchestrates all decision readiness checks:
 * - CMA quality
 * - Net sheet validity
 * - Presentation readiness
 * - Override authority
 * - Decision reversal rules
 * 
 * This is GOVERNANCE ONLY - no execution logic
 */

import { evaluateCMAQuality, deriveCMAQualityFromEvents } from "./cma-quality-evaluator"
import { validateNetSheetValidity, deriveNetSheetValidityFromEvents } from "./net-sheet-validator"
import {
  evaluatePresentationReadiness,
  derivePresentationReadinessFromEvents,
} from "./presentation-readiness"
import { checkPrerequisites, type SellerDecisionState } from "./decision-state-definitions"
import { isValidUUID } from "@/lib/validations"

export interface DecisionReadinessInput {
  listingId: string
  targetState: SellerDecisionState
  
  // Optional overrides
  overrideByRole?: "agent" | "team_lead" | "broker" | "admin"
  overrideReason?: string
  
  // Current listing stage (for reversal validation)
  currentListingStage?: string
}

export interface DecisionReadinessResult {
  isReady: boolean
  targetState: SellerDecisionState
  
  // Component checks
  cmaReady: boolean
  netSheetReady: boolean
  presentationReady: boolean
  
  // Prerequisites check
  prerequisitesMet: boolean
  missingPrerequisites: string[]
  
  // Authority check
  authorityValid: boolean
  requiredRole: string
  
  // Override tracking
  wasOverridden: boolean
  overrideBy?: string
  overrideReason?: string
  
  // Blockers and warnings
  blockers: string[]
  warnings: string[]
}

/**
 * Evaluate decision readiness for a target state
 */
export async function evaluateDecisionReadiness(
  input: DecisionReadinessInput
): Promise<DecisionReadinessResult> {
  // Validation
  if (!isValidUUID(input.listingId)) {
    return {
      isReady: false,
      targetState: input.targetState,
      cmaReady: false,
      netSheetReady: false,
      presentationReady: false,
      prerequisitesMet: false,
      missingPrerequisites: ["Invalid listing ID"],
      authorityValid: false,
      requiredRole: "agent",
      wasOverridden: false,
      blockers: ["Invalid listing ID"],
      warnings: [],
    }
  }
  
  // Derive readiness from events
  const cmaInput = await deriveCMAQualityFromEvents(input.listingId)
  const netSheetInput = await deriveNetSheetValidityFromEvents(input.listingId)
  const presentationInput = await derivePresentationReadinessFromEvents(input.listingId)
  
  // Apply overrides if provided
  if (cmaInput && input.overrideByRole) {
    cmaInput.overrideByRole = input.overrideByRole
    cmaInput.overrideReason = input.overrideReason
  }
  if (netSheetInput && input.overrideByRole) {
    netSheetInput.overrideByRole = input.overrideByRole
    netSheetInput.overrideReason = input.overrideReason
  }
  
  // Evaluate components
  const cmaResult = cmaInput ? await evaluateCMAQuality(cmaInput) : null
  const netSheetResult = netSheetInput ? validateNetSheetValidity(netSheetInput) : null
  const presentationResult = presentationInput
    ? evaluatePresentationReadiness(presentationInput)
    : null
  
  const cmaReady = cmaResult?.isReady || false
  const netSheetReady = netSheetResult?.isValid || false
  const presentationReady = presentationResult?.presentationReady || false
  
  // Check prerequisites
  const prereqCheck = checkPrerequisites(input.targetState, {
    cmaReady,
    netSheetReady,
    presentationAssembled: presentationReady,
    presentationVideoReady: presentationResult?.videoReady,
  })
  
  // Collect blockers and warnings
  const blockers: string[] = []
  const warnings: string[] = []
  
  if (!prereqCheck.met) {
    blockers.push(...prereqCheck.missing)
  }
  
  if (cmaResult?.violations) {
    blockers.push(...cmaResult.violations)
  }
  if (cmaResult?.warnings) {
    warnings.push(...cmaResult.warnings)
  }
  
  if (netSheetResult?.warnings) {
    warnings.push(...netSheetResult.warnings)
  }
  
  if (presentationResult?.warnings) {
    warnings.push(...presentationResult.warnings)
  }
  
  // Check override
  const wasOverridden =
    (cmaResult?.wasOverridden || false) ||
    (netSheetResult?.wasOverridden || false)
  
  const isReady = prereqCheck.met && blockers.length === 0
  
  return {
    isReady,
    targetState: input.targetState,
    cmaReady,
    netSheetReady,
    presentationReady,
    prerequisitesMet: prereqCheck.met,
    missingPrerequisites: prereqCheck.missing,
    authorityValid: true, // Authority validated in transition logic
    requiredRole: "agent",
    wasOverridden,
    overrideBy: input.overrideByRole,
    overrideReason: input.overrideReason,
    blockers,
    warnings,
  }
}

/**
 * Check if SELLER_DECISION_READY state can be achieved
 */
export async function isDecisionReady(listingId: string): Promise<boolean> {
  const result = await evaluateDecisionReadiness({
    listingId,
    targetState: "SELLER_DECISION_READY",
  })
  return result.isReady
}

/**
 * Validate decision reversal
 */
export function validateDecisionReversal(
  currentDecisionState: SellerDecisionState,
  currentListingStage: string
): { allowed: boolean; reason?: string } {
  // Decision reversal only allowed for DECISION_READY state
  if (currentDecisionState !== "SELLER_DECISION_READY") {
    return {
      allowed: false,
      reason: "Reversal only allowed from SELLER_DECISION_READY state",
    }
  }
  
  // Cannot reverse after MLS_ACTIVE
  if (currentListingStage === "MLS_ACTIVE" || currentListingStage === "SHOWINGS_ACTIVE") {
    return {
      allowed: false,
      reason: "Cannot reverse decision after MLS activation",
    }
  }
  
  return { allowed: true }
}
