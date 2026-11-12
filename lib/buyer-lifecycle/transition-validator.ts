/**
 * System 5.1C: Buyer Lifecycle Governance Core - Transition Validator
 * 
 * Validates state transitions based on:
 * - Allowed previous states
 * - Financial verification requirements
 * - Role-based authority
 * - Frozen state protection
 * 
 * This is GOVERNANCE ONLY - does not execute transitions
 */

import {
  getStateDefinition,
  isStateFrozen,
  requiresFinancialVerification,
  type BuyerState,
  type RequiredRole,
} from "./lifecycle-definitions"
import { checkFinancialVerification, type FinancialVerificationResult } from "./financial-verification"

export interface TransitionValidationContext {
  // Current state
  currentState: BuyerState | null
  targetState: BuyerState
  
  // User context
  userRole: string
  userId: string
  
  // Contact context
  contactId: string
  
  // Financial verification (can be provided or will be checked)
  financialVerification?: FinancialVerificationResult
  
  // Admin override
  isAdminOverride?: boolean
  overrideReason?: string
}

export interface TransitionValidationResult {
  allowed: boolean
  reason?: string
  warnings?: string[]
  blockers?: string[]
}

/**
 * Validates if a state transition is allowed
 */
export async function validateStateTransition(
  context: TransitionValidationContext
): Promise<TransitionValidationResult> {
  const {
    currentState,
    targetState,
    userRole,
    contactId,
    financialVerification,
    isAdminOverride,
  } = context
  
  // Get target state definition
  const targetDef = getStateDefinition(targetState)
  
  if (!targetDef) {
    return {
      allowed: false,
      reason: `Unknown state: ${targetState}`,
    }
  }
  
  // FROZEN STATE CHECK
  if (currentState && isStateFrozen(currentState)) {
    return {
      allowed: false,
      reason: `Current state "${currentState}" is frozen - no transitions allowed (transaction system has taken over)`,
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
  
  // 2. PREVIOUS STATE CHECK
  if (currentState) {
    const previousCheck = validatePreviousState(currentState, targetDef)
    if (!previousCheck.allowed) {
      return previousCheck
    }
  } else {
    // No current state - must be first state
    if (targetDef.allowedFrom.length > 0) {
      return {
        allowed: false,
        reason: `Cannot start at state "${targetState}" - must start from BUYER_CONTACT_CREATED`,
      }
    }
  }
  
  // 3. FINANCIAL VERIFICATION CHECK
  if (targetDef.requiresFinancialVerification) {
    const finVerification =
      financialVerification || (await checkFinancialVerification({ contactId }))
    
    if (!finVerification.isVerified) {
      return {
        allowed: false,
        reason: `Financial verification required to enter "${targetState}". Buyer must be financially verified first.`,
        blockers: ["financial_verification_required"],
      }
    }
  }
  
  // All validations passed
  return {
    allowed: true,
  }
}

/**
 * Validates role authority for state transition
 */
function validateRoleAuthority(
  userRole: string,
  requiredRoles: RequiredRole[]
): TransitionValidationResult {
  const normalizedRole = userRole.toLowerCase() as RequiredRole
  
  if (!requiredRoles.includes(normalizedRole)) {
    return {
      allowed: false,
      reason: `Role "${userRole}" is not authorized to advance to this state. Required roles: ${requiredRoles.join(", ")}`,
    }
  }
  
  return { allowed: true }
}

/**
 * Validates previous state is allowed
 */
function validatePreviousState(
  currentState: BuyerState,
  targetDef: ReturnType<typeof getStateDefinition>
): TransitionValidationResult {
  if (!targetDef) {
    return { allowed: false, reason: "Invalid target state" }
  }
  
  // Check if current state is in allowed list
  if (!targetDef.allowedFrom.includes(currentState)) {
    return {
      allowed: false,
      reason: `Cannot advance from "${currentState}" to "${targetDef.state}". Allowed previous states: ${targetDef.allowedFrom.join(", ") || "none"}`,
    }
  }
  
  return { allowed: true }
}

/**
 * Get next allowed states from current state
 */
export function getNextAllowedStates(
  currentState: BuyerState,
  userRole: string
): BuyerState[] {
  const normalizedRole = userRole.toLowerCase() as RequiredRole
  const allowedStates: BuyerState[] = []
  
  // Import state definitions
  const { getAllStates } = require("./lifecycle-definitions")
  const allStates = getAllStates()
  
  for (const stateDef of allStates) {
    // Check if current state is in allowed previous states
    if (stateDef.allowedFrom.includes(currentState)) {
      // Check if user has required role
      if (stateDef.requiredRoles.includes(normalizedRole)) {
        allowedStates.push(stateDef.state)
      }
    }
  }
  
  return allowedStates
}

/**
 * Check if user can skip states (admin/broker only)
 */
export function canSkipStates(userRole: string): boolean {
  const normalizedRole = userRole.toLowerCase()
  return normalizedRole === "admin" || normalizedRole === "broker"
}

/**
 * Validate rollback to ON_HOLD or DISENGAGED
 */
export function validateRollback(
  currentState: BuyerState,
  targetState: "BUYER_ON_HOLD" | "BUYER_DISENGAGED",
  userRole: string
): TransitionValidationResult {
  // Cannot rollback from frozen state
  if (isStateFrozen(currentState)) {
    return {
      allowed: false,
      reason: `Cannot rollback from frozen state "${currentState}"`,
    }
  }
  
  // Check role authority
  const normalizedRole = userRole.toLowerCase() as RequiredRole
  const allowedRoles: RequiredRole[] = ["agent", "team_lead", "broker", "admin"]
  
  if (!allowedRoles.includes(normalizedRole)) {
    return {
      allowed: false,
      reason: `Role "${userRole}" is not authorized to rollback buyer state`,
    }
  }
  
  // Get target definition to check allowed from
  const targetDef = getStateDefinition(targetState)
  if (!targetDef) {
    return { allowed: false, reason: "Invalid target state" }
  }
  
  if (!targetDef.allowedFrom.includes(currentState)) {
    return {
      allowed: false,
      reason: `Cannot rollback from "${currentState}" to "${targetState}"`,
    }
  }
  
  return { allowed: true }
}

/**
 * Validate reactivation from ON_HOLD or DISENGAGED
 */
export async function validateReactivation(
  currentState: "BUYER_ON_HOLD" | "BUYER_DISENGAGED",
  targetState: BuyerState,
  contactId: string,
  userRole: string
): Promise<TransitionValidationResult> {
  // ── `currentState` WAS ACCEPTED AND NEVER READ ────────────────────────────
  //
  // Its sibling `validateRollback` above tests
  // `targetDef.allowedFrom.includes(currentState)`; this one took the same
  // argument and never looked at it, so "reactivate" would accept ANY target
  // state, including the paused state the buyer is already sitting in.
  //
  // The allowedFrom test is NOT the right check here, and that was verified
  // against lifecycle-definitions.ts rather than assumed: NO state lists
  // BUYER_ON_HOLD or BUYER_DISENGAGED in its allowedFrom except
  // BUYER_DISENGAGED itself (which lists BUYER_ON_HOLD). Reactivation edges are
  // deliberately absent from the graph — that is WHY this separate validator
  // exists — so importing the sibling's test verbatim would have refused every
  // reactivation there is. Pinning to the graph would have been the wrong build.
  //
  // What the argument is genuinely for is the pair check the word "reactivate"
  // implies: the target must be somewhere OTHER than the paused states.
  // ON_HOLD → DISENGAGED is a real transition, but it is a further
  // disengagement and the ordinary `validateStateTransition` path already
  // admits it (it IS in BUYER_DISENGAGED.allowedFrom); routing it through the
  // reactivation gate would let it skip that path's frozen-state and
  // allowedFrom checks.
  if (targetState === currentState) {
    return {
      allowed: false,
      reason: `Buyer is already "${currentState}" — reactivation must name a different state`,
    }
  }

  if (targetState === "BUYER_ON_HOLD" || targetState === "BUYER_DISENGAGED") {
    return {
      allowed: false,
      reason:
        `"${targetState}" is not a reactivation from "${currentState}" — ` +
        `use the ordinary transition validator, which carries the frozen-state and allowed-from checks`,
      blockers: ["not_a_reactivation"],
    }
  }

  // Check if target state requires financial verification
  if (requiresFinancialVerification(targetState)) {
    const verification = await checkFinancialVerification({ contactId })
    
    if (!verification.isVerified) {
      return {
        allowed: false,
        reason: "Financial verification required to reactivate buyer",
        blockers: ["financial_verification_required"],
      }
    }
  }
  
  // Check role authority
  const normalizedRole = userRole.toLowerCase() as RequiredRole
  const allowedRoles: RequiredRole[] = ["agent", "team_lead", "broker", "admin"]
  
  if (!allowedRoles.includes(normalizedRole)) {
    return {
      allowed: false,
      reason: `Role "${userRole}" is not authorized to reactivate buyer`,
    }
  }
  
  return { allowed: true }
}

/**
 * Validate batch transitions (for admin tools)
 */
export interface BulkTransitionValidation {
  contactId: string
  currentState: BuyerState | null
  targetState: BuyerState
}

export interface BulkTransitionResult {
  validTransitions: string[]
  invalidTransitions: Array<{ contactId: string; reason: string }>
  totalProcessed: number
}

export async function validateBulkTransitions(
  transitions: BulkTransitionValidation[],
  userRole: string,
  userId: string
): Promise<BulkTransitionResult> {
  const validTransitions: string[] = []
  const invalidTransitions: Array<{ contactId: string; reason: string }> = []
  
  for (const transition of transitions) {
    const result = await validateStateTransition({
      currentState: transition.currentState,
      targetState: transition.targetState,
      userRole,
      userId,
      contactId: transition.contactId,
    })
    
    if (result.allowed) {
      validTransitions.push(transition.contactId)
    } else {
      invalidTransitions.push({
        contactId: transition.contactId,
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
