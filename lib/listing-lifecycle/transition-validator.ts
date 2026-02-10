/**
 * System 5.2: Listing Lifecycle Core - Transition Validator
 * 
 * Validates stage transitions based on:
 * - Allowed previous stages
 * - Required readiness checks
 * - Role-based authority
 * - Admin override capabilities
 * 
 * This is GOVERNANCE ONLY - does not execute transitions
 */

import { getStageDefinition, type ListingStage, type RequiredRole } from "./lifecycle-definitions"

export interface TransitionValidationContext {
  // Current state
  currentStage: ListingStage | null
  targetStage: ListingStage
  
  // User context
  userRole: string
  userId: string
  
  // Listing context
  listingId: string
  
  // Readiness checks (provided by caller)
  completedReadinessChecks: string[]
  
  // Admin override
  isAdminOverride?: boolean
  overrideReason?: string
}

export interface TransitionValidationResult {
  allowed: boolean
  reason?: string
  warnings?: string[]
  requiredChecks?: string[]
  missingChecks?: string[]
}

/**
 * Validates if a stage transition is allowed
 */
export function validateStageTransition(context: TransitionValidationContext): TransitionValidationResult {
  const { currentStage, targetStage, userRole, completedReadinessChecks, isAdminOverride } = context
  
  // Get target stage definition
  const targetDef = getStageDefinition(targetStage)
  
  if (!targetDef) {
    return {
      allowed: false,
      reason: `Unknown stage: ${targetStage}`,
    }
  }
  
  // ADMIN OVERRIDE PATH
  if (isAdminOverride && (userRole === "admin" || userRole === "broker")) {
    return {
      allowed: true,
      warnings: ["Admin override applied - skipping normal validation"],
    }
  }
  
  // 1. ROLE AUTHORITY CHECK
  const roleCheck = validateRoleAuthority(userRole, targetDef.requiredRoles)
  if (!roleCheck.allowed) {
    return roleCheck
  }
  
  // 2. PREVIOUS STAGE CHECK
  if (currentStage) {
    const previousCheck = validatePreviousStage(currentStage, targetDef)
    if (!previousCheck.allowed) {
      return previousCheck
    }
  } else {
    // No current stage - must be first stage
    if (targetDef.allowedFrom.length > 0) {
      return {
        allowed: false,
        reason: `Cannot start at stage "${targetStage}" - must start from allowed initial stages`,
      }
    }
  }
  
  // 3. READINESS CHECKS
  const readinessCheck = validateReadinessChecks(
    targetDef.readinessChecks,
    completedReadinessChecks
  )
  if (!readinessCheck.allowed) {
    return readinessCheck
  }
  
  // All validations passed
  return {
    allowed: true,
    warnings: readinessCheck.warnings,
  }
}

/**
 * Validates role authority for stage transition
 */
function validateRoleAuthority(
  userRole: string,
  requiredRoles: RequiredRole[]
): TransitionValidationResult {
  const normalizedRole = userRole.toLowerCase() as RequiredRole
  
  if (!requiredRoles.includes(normalizedRole)) {
    return {
      allowed: false,
      reason: `Role "${userRole}" is not authorized to advance to this stage. Required roles: ${requiredRoles.join(", ")}`,
    }
  }
  
  return { allowed: true }
}

/**
 * Validates previous stage is allowed
 */
function validatePreviousStage(
  currentStage: ListingStage,
  targetDef: ReturnType<typeof getStageDefinition>
): TransitionValidationResult {
  if (!targetDef) {
    return { allowed: false, reason: "Invalid target stage" }
  }
  
  // Check if current stage is in allowed list
  if (!targetDef.allowedFrom.includes(currentStage)) {
    return {
      allowed: false,
      reason: `Cannot advance from "${currentStage}" to "${targetDef.stage}". Allowed previous stages: ${targetDef.allowedFrom.join(", ") || "none"}`,
    }
  }
  
  return { allowed: true }
}

/**
 * Validates readiness checks are completed
 */
function validateReadinessChecks(
  requiredChecks: string[],
  completedChecks: string[]
): TransitionValidationResult {
  if (requiredChecks.length === 0) {
    return { allowed: true }
  }
  
  const missingChecks = requiredChecks.filter(
    (check) => !completedChecks.includes(check)
  )
  
  if (missingChecks.length > 0) {
    return {
      allowed: false,
      reason: `Missing required readiness checks: ${missingChecks.join(", ")}`,
      requiredChecks,
      missingChecks,
    }
  }
  
  return { allowed: true }
}

/**
 * Validates bulk transitions (for admin tools)
 */
export interface BulkTransitionValidation {
  listingId: string
  currentStage: ListingStage | null
  targetStage: ListingStage
  completedReadinessChecks: string[]
}

export interface BulkTransitionResult {
  validTransitions: string[]
  invalidTransitions: Array<{ listingId: string; reason: string }>
  totalProcessed: number
}

export function validateBulkTransitions(
  transitions: BulkTransitionValidation[],
  userRole: string,
  userId: string
): BulkTransitionResult {
  const validTransitions: string[] = []
  const invalidTransitions: Array<{ listingId: string; reason: string }> = []
  
  for (const transition of transitions) {
    const result = validateStageTransition({
      currentStage: transition.currentStage,
      targetStage: transition.targetStage,
      userRole,
      userId,
      listingId: transition.listingId,
      completedReadinessChecks: transition.completedReadinessChecks,
    })
    
    if (result.allowed) {
      validTransitions.push(transition.listingId)
    } else {
      invalidTransitions.push({
        listingId: transition.listingId,
        reason: result.reason || "Unknown error",
      })
    }
  }
  
  return {
    validTransitions,
    invalidTransitions,
    totalProcessed: transitions.length,
  }
}

/**
 * Get next allowed stages from current stage
 */
export function getNextAllowedStages(
  currentStage: ListingStage,
  userRole: string
): ListingStage[] {
  const normalizedRole = userRole.toLowerCase() as RequiredRole
  const allowedStages: ListingStage[] = []
  
  // Import stage definitions
  const { getAllStages } = require("./lifecycle-definitions")
  const allStages = getAllStages()
  
  for (const stageDef of allStages) {
    // Check if current stage is in allowed previous stages
    if (stageDef.allowedFrom.includes(currentStage)) {
      // Check if user has required role
      if (stageDef.requiredRoles.includes(normalizedRole)) {
        allowedStages.push(stageDef.stage)
      }
    }
  }
  
  return allowedStages
}

/**
 * Check if user can skip stages (admin/broker only)
 */
export function canSkipStages(userRole: string): boolean {
  const normalizedRole = userRole.toLowerCase()
  return normalizedRole === "admin" || normalizedRole === "broker"
}

/**
 * Validate skip-stage transition with override
 */
export function validateSkipStageTransition(
  context: TransitionValidationContext & {
    skippedStages: ListingStage[]
  }
): TransitionValidationResult {
  // Only admin/broker can skip
  if (!canSkipStages(context.userRole)) {
    return {
      allowed: false,
      reason: "Only admins and brokers can skip stages",
    }
  }
  
  // Require override reason
  if (!context.overrideReason) {
    return {
      allowed: false,
      reason: "Override reason required for stage skipping",
    }
  }
  
  // Allow with warning
  return {
    allowed: true,
    warnings: [
      `Skipping ${context.skippedStages.length} stage(s): ${context.skippedStages.join(", ")}`,
      `Override reason: ${context.overrideReason}`,
    ],
  }
}
