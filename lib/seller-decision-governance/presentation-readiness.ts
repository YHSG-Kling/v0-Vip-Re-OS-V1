/**
 * System 5.3: CMA & Listing Presentation Governance Engine
 * Presentation Readiness Evaluator
 * 
 * Evaluates presentation readiness based on:
 * - Presentation assembly status
 * - Presentation video status
 * - Drip sequence gating rules
 * 
 * This is GOVERNANCE ONLY - no presentation generation, no drip execution
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import type { SellerDecisionState } from "./decision-state-definitions"

export interface PresentationReadinessInput {
  listingId: string
  
  // Presentation status (derived from activities or passed in)
  presentationAssembled?: boolean
  presentationVideoReady?: boolean
  
  // Current decision state (for drip gating)
  currentDecisionState?: SellerDecisionState
}

export interface PresentationReadinessResult {
  presentationReady: boolean
  videoReady: boolean
  
  // Drip sequence gating
  dripSequenceAllowed: boolean
  dripShouldPause: boolean
  dripShouldContinue: boolean
  
  checks: {
    materialsAssembled: boolean
    videoGenerated: boolean
    stateAllowsDrip: boolean
  }
  
  warnings: string[]
}

/**
 * Evaluate presentation readiness
 */
export function evaluatePresentationReadiness(
  input: PresentationReadinessInput
): PresentationReadinessResult {
  // Validation
  if (!isValidUUID(input.listingId)) {
    return {
      presentationReady: false,
      videoReady: false,
      dripSequenceAllowed: false,
      dripShouldPause: false,
      dripShouldContinue: false,
      checks: {
        materialsAssembled: false,
        videoGenerated: false,
        stateAllowsDrip: false,
      },
      warnings: ["Invalid listing ID"],
    }
  }
  
  const checks = {
    materialsAssembled: input.presentationAssembled || false,
    videoGenerated: input.presentationVideoReady || false,
    stateAllowsDrip: evaluateDripSequenceGating(input.currentDecisionState),
  }
  
  const warnings: string[] = []
  
  // Drip sequence rules
  const dripSequenceAllowed = checks.materialsAssembled && checks.stateAllowsDrip
  const dripShouldPause = shouldPauseDrip(input.currentDecisionState)
  const dripShouldContinue = shouldContinueDrip(input.currentDecisionState)
  
  if (checks.materialsAssembled && !checks.videoGenerated) {
    warnings.push("Presentation video not yet ready - consider generating for enhanced engagement")
  }
  
  if (!dripSequenceAllowed && checks.materialsAssembled) {
    warnings.push("Drip sequence gated by current decision state")
  }
  
  return {
    presentationReady: checks.materialsAssembled,
    videoReady: checks.videoGenerated,
    dripSequenceAllowed,
    dripShouldPause,
    dripShouldContinue,
    checks,
    warnings,
  }
}

/**
 * Evaluate if drip sequence is allowed for a given state
 */
function evaluateDripSequenceGating(state?: SellerDecisionState): boolean {
  if (!state) return false
  
  // Drip can start at PRESENTATION_ASSEMBLED
  // Drip must pause at DECISION_READY or DECLINED
  // Drip can continue through DEFERRED
  
  const allowedStates: SellerDecisionState[] = [
    "SELLER_PRESENTATION_ASSEMBLED",
    "SELLER_PRESENTATION_VIDEO_READY",
    "SELLER_DECISION_DEFERRED",
  ]
  
  return allowedStates.includes(state)
}

/**
 * Check if drip sequence should pause
 */
function shouldPauseDrip(state?: SellerDecisionState): boolean {
  if (!state) return false
  
  const pauseStates: SellerDecisionState[] = [
    "SELLER_DECISION_READY",
    "SELLER_DECISION_DECLINED",
  ]
  
  return pauseStates.includes(state)
}

/**
 * Check if drip sequence should continue
 */
function shouldContinueDrip(state?: SellerDecisionState): boolean {
  if (!state) return false
  
  const continueStates: SellerDecisionState[] = [
    "SELLER_PRESENTATION_ASSEMBLED",
    "SELLER_PRESENTATION_VIDEO_READY",
    "SELLER_DECISION_DEFERRED",
  ]
  
  return continueStates.includes(state)
}

/**
 * Derive presentation readiness from activities events
 */
export async function derivePresentationReadinessFromEvents(
  listingId: string
): Promise<PresentationReadinessInput | null> {
  if (!isValidUUID(listingId)) {
    return null
  }
  
  const supabase = await createClient()
  
  // Query activities for presentation-related events
  const { data: events, error } = await supabase
    .from("activities")
    .select("activity_type, metadata, created_at")
    .eq("listing_id", listingId)
    .or(
      "activity_type.eq.seller.presentation.assembled,activity_type.eq.seller.presentation_video.ready,activity_type.eq.seller.decision.transition"
    )
    .order("created_at", { ascending: false })
    .limit(20)
  
  if (error || !events || events.length === 0) {
    return null
  }
  
  let presentationAssembled = false
  let presentationVideoReady = false
  let currentDecisionState: SellerDecisionState | undefined
  
  for (const event of events) {
    if (event.activity_type === "seller.presentation.assembled") {
      presentationAssembled = true
    }
    
    if (event.activity_type === "seller.presentation_video.ready") {
      presentationVideoReady = true
    }
    
    if (event.activity_type === "seller.decision.transition") {
      const meta = event.metadata as any
      currentDecisionState = meta?.to_state || meta?.toState
      if (currentDecisionState) break // Use most recent state
    }
  }
  
  return {
    listingId,
    presentationAssembled,
    presentationVideoReady,
    currentDecisionState,
  }
}

/**
 * Check if presentation is ready (quick check)
 */
export async function isPresentationReady(listingId: string): Promise<boolean> {
  const input = await derivePresentationReadinessFromEvents(listingId)
  if (!input) return false
  
  const result = evaluatePresentationReadiness(input)
  return result.presentationReady
}
