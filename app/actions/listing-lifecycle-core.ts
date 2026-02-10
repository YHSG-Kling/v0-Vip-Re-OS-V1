/**
 * System 5.2: Listing Lifecycle Core - Server Actions
 * 
 * Public API for listing lifecycle governance.
 * This system does NOT execute work - it validates, enforces, gates, and logs.
 */

"use server"

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import {
  type ListingStage,
  getStageDefinition,
  getAllStages,
  getEnabledSystemGates,
  isSystemGateEnabled,
} from "@/lib/listing-lifecycle/lifecycle-definitions"
import {
  validateStageTransition,
  getNextAllowedStages,
  canSkipStages,
  validateSkipStageTransition,
  type TransitionValidationContext,
} from "@/lib/listing-lifecycle/transition-validator"
import { evaluateReadinessChecks } from "@/lib/listing-lifecycle/readiness-checker"
import {
  logStageTransition,
  logFailedTransition,
  logSystemGateEnabled,
  getLifecycleHistory,
  getCurrentLifecycleStage,
  getLifecycleStatistics,
  getStageTimingMetrics,
} from "@/lib/listing-lifecycle/lifecycle-logger"

// ============================================
// LIFECYCLE VALIDATION ACTIONS
// ============================================

/**
 * Validate if a stage transition is allowed
 * DOES NOT execute the transition - only validates
 */
export async function validateListingTransition(params: {
  listingId: string
  targetStage: ListingStage
  overrideReason?: string
}) {
  const supabase = await createClient()
  
  // Validate inputs
  if (!isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  
  // Get user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: "Not authenticated" }
  }
  
  // Get user profile with role
  const { data: profile } = await supabase
    .from("users")
    .select("role, brokerage_id")
    .eq("id", user.id)
    .single()
  
  if (!profile) {
    return { success: false, error: "User profile not found" }
  }
  
  // Get listing with current stage
  const { data: listing } = await supabase
    .from("listings")
    .select("id, agent_id, brokerage_id")
    .eq("id", params.listingId)
    .single()
  
  if (!listing) {
    return { success: false, error: "Listing not found" }
  }
  
  // Get current stage from lifecycle history
  const currentStage = await getCurrentLifecycleStage(supabase, params.listingId)
  
  // Evaluate readiness checks
  const targetDef = getStageDefinition(params.targetStage)
  if (!targetDef) {
    return { success: false, error: "Invalid target stage" }
  }
  
  const readinessEval = await evaluateReadinessChecks(
    supabase,
    params.listingId,
    targetDef.readinessChecks
  )
  
  // Validate transition
  const validationContext: TransitionValidationContext = {
    currentStage,
    targetStage: params.targetStage,
    userRole: profile.role || "agent",
    userId: user.id,
    listingId: params.listingId,
    completedReadinessChecks: readinessEval.passedChecks,
    isAdminOverride: !!params.overrideReason,
    overrideReason: params.overrideReason,
  }
  
  const validation = validateStageTransition(validationContext)
  
  return {
    success: true,
    validation: {
      allowed: validation.allowed,
      reason: validation.reason,
      warnings: validation.warnings,
      currentStage,
      targetStage: params.targetStage,
      readinessChecks: {
        allPassed: readinessEval.allPassed,
        passed: readinessEval.passedChecks,
        failed: readinessEval.failedChecks,
        results: readinessEval.results,
      },
      nextAllowedStages: validation.allowed
        ? []
        : getNextAllowedStages(currentStage || "LEAD", profile.role || "agent"),
    },
  }
}

/**
 * Execute a stage transition (after validation)
 * This is the ONLY action that modifies listing lifecycle state
 */
export async function executeListingTransition(params: {
  listingId: string
  targetStage: ListingStage
  notes?: string
  overrideReason?: string
}) {
  const supabase = await createClient()
  
  // Validate inputs
  if (!isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  
  // Get user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: "Not authenticated" }
  }
  
  // Get user profile with role
  const { data: profile } = await supabase
    .from("users")
    .select("role, brokerage_id")
    .eq("id", user.id)
    .single()
  
  if (!profile) {
    return { success: false, error: "User profile not found" }
  }
  
  // Get listing
  const { data: listing } = await supabase
    .from("listings")
    .select("id, agent_id, brokerage_id")
    .eq("id", params.listingId)
    .single()
  
  if (!listing) {
    return { success: false, error: "Listing not found" }
  }
  
  // Get current stage
  const currentStage = await getCurrentLifecycleStage(supabase, params.listingId)
  
  // Validate first
  const validation = await validateListingTransition({
    listingId: params.listingId,
    targetStage: params.targetStage,
    overrideReason: params.overrideReason,
  })
  
  if (!validation.success || !validation.validation?.allowed) {
    // Log failed attempt
    await logFailedTransition(supabase, {
      listingId: params.listingId,
      agentId: listing.agent_id,
      brokerageId: listing.brokerage_id,
      fromStage: currentStage,
      toStage: params.targetStage,
      userId: user.id,
      userRole: profile.role || "agent",
      failureReason: validation.validation?.reason || validation.error || "Validation failed",
      readinessChecksPassed: validation.validation?.readinessChecks?.passed || [],
      readinessChecksFailed: validation.validation?.readinessChecks?.failed || [],
    })
    
    return {
      success: false,
      error: validation.validation?.reason || validation.error || "Transition not allowed",
      validation: validation.validation,
    }
  }
  
  // Log successful transition
  await logStageTransition(supabase, {
    listingId: params.listingId,
    agentId: listing.agent_id,
    brokerageId: listing.brokerage_id,
    fromStage: currentStage,
    toStage: params.targetStage,
    userId: user.id,
    userRole: profile.role || "agent",
    isOverride: !!params.overrideReason,
    overrideReason: params.overrideReason,
    readinessChecksPassed: validation.validation?.readinessChecks?.passed || [],
    notes: params.notes,
  })
  
  // Log system gates if enabled
  const targetDef = getStageDefinition(params.targetStage)
  if (targetDef?.enablesSystemGates) {
    for (const gateName of targetDef.enablesSystemGates) {
      await logSystemGateEnabled(supabase, {
        listingId: params.listingId,
        agentId: listing.agent_id,
        brokerageId: listing.brokerage_id,
        stage: params.targetStage,
        gateName,
      })
    }
  }
  
  return {
    success: true,
    transition: {
      fromStage: currentStage,
      toStage: params.targetStage,
      timestamp: new Date().toISOString(),
      enabledSystemGates: targetDef?.enablesSystemGates || [],
    },
  }
}

// ============================================
// LIFECYCLE QUERY ACTIONS
// ============================================

/**
 * Get all available lifecycle stages
 */
export async function getLifecycleStages() {
  return {
    success: true,
    stages: getAllStages(),
  }
}

/**
 * Get lifecycle history for a listing
 */
export async function getListingLifecycleHistory(listingId: string) {
  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  const history = await getLifecycleHistory(supabase, listingId)
  
  return {
    success: true,
    history,
  }
}

/**
 * Get current lifecycle stage for a listing
 */
export async function getListingCurrentStage(listingId: string) {
  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  const currentStage = await getCurrentLifecycleStage(supabase, listingId)
  
  return {
    success: true,
    currentStage,
  }
}

/**
 * Get next allowed stages for a listing
 */
export async function getListingNextStages(listingId: string) {
  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  
  // Get user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: "Not authenticated" }
  }
  
  // Get user role
  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single()
  
  // Get current stage
  const currentStage = await getCurrentLifecycleStage(supabase, listingId)
  
  if (!currentStage) {
    return {
      success: true,
      nextStages: ["LEAD"] as ListingStage[],
    }
  }
  
  const nextStages = getNextAllowedStages(
    currentStage,
    profile?.role || "agent"
  )
  
  return {
    success: true,
    currentStage,
    nextStages,
    canSkipStages: canSkipStages(profile?.role || "agent"),
  }
}

// ============================================
// SYSTEM GATE QUERY ACTIONS
// ============================================

/**
 * Check if a system gate is enabled for a listing
 */
export async function checkSystemGate(params: {
  listingId: string
  gateName: string
}) {
  if (!isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  const currentStage = await getCurrentLifecycleStage(supabase, params.listingId)
  
  if (!currentStage) {
    return {
      success: true,
      enabled: false,
      reason: "Listing has no lifecycle stage",
    }
  }
  
  const enabled = isSystemGateEnabled(currentStage, params.gateName)
  
  return {
    success: true,
    enabled,
    currentStage,
    gateName: params.gateName,
  }
}

/**
 * Get all enabled system gates for a listing
 */
export async function getEnabledGates(listingId: string) {
  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  
  const supabase = await createClient()
  const currentStage = await getCurrentLifecycleStage(supabase, listingId)
  
  if (!currentStage) {
    return {
      success: true,
      enabledGates: [],
      reason: "Listing has no lifecycle stage",
    }
  }
  
  const enabledGates = getEnabledSystemGates(currentStage)
  
  return {
    success: true,
    currentStage,
    enabledGates,
  }
}

// ============================================
// STATISTICS & REPORTING ACTIONS
// ============================================

/**
 * Get lifecycle statistics for a brokerage
 */
export async function getBrokerageLifecycleStats(params?: {
  dateFrom?: string
  dateTo?: string
}) {
  const supabase = await createClient()
  
  // Get user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: "Not authenticated" }
  }
  
  // Get user brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .single()
  
  if (!profile?.brokerage_id) {
    return { success: false, error: "No brokerage found" }
  }
  
  const stats = await getLifecycleStatistics(supabase, profile.brokerage_id, params)
  
  return {
    success: true,
    statistics: stats,
  }
}

/**
 * Get stage timing metrics for a brokerage
 */
export async function getBrokerageStageTimings(params?: {
  dateFrom?: string
  dateTo?: string
}) {
  const supabase = await createClient()
  
  // Get user
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: "Not authenticated" }
  }
  
  // Get user brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .single()
  
  if (!profile?.brokerage_id) {
    return { success: false, error: "No brokerage found" }
  }
  
  const timings = await getStageTimingMetrics(supabase, profile.brokerage_id, params)
  
  return {
    success: true,
    timings,
  }
}
