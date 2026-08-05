/**
 * System 5.1C: Buyer Lifecycle Governance Core - Server Actions
 * 
 * Public API for buyer lifecycle governance.
 * All actions are governance-only - validate, gate, and log.
 * 
 * NO execution logic, NO UI, NO lender integrations
 */

"use server"

import { isValidUUID } from "@/lib/validations"
import { createClient } from "@/lib/supabase/server"
import {
  validateStateTransition,
  validateRollback,
  validateReactivation,
  getNextAllowedStates,
  emitLifecycleTransition,
  getLifecycleHistory,
  getCurrentBuyerState as getStateFromHistory,
  getLifecycleStatistics,
  getBuyersInState,
  isSearchAllowed,
  isTourAllowed,
  isOfferAllowed,
  getEnabledGatesForBuyer,
  checkFinancialVerification,
  emitFinancialVerificationEvent,
  getFinancialVerificationStatus,
  type TransitionValidationResult,
  type LifecycleHistoryEntry,
  type LifecycleStatistics,
  type GatingResult,
  type FinancialVerificationResult,
  type FinancialVerificationStatus,
  type BuyerState,
} from "@/lib/buyer-lifecycle"

/**
 * Resolve the ACTOR and the TENANT from the session.
 *
 * The two brokerage-wide readers below used to take `brokerageId` as a
 * parameter and hand it straight to lib/buyer-lifecycle, which reads through a
 * SERVICE-ROLE client (RLS does not apply). Any signed-in user could therefore
 * pass any other brokerage's uuid and receive that brokerage's buyer counts and
 * its contact ids. Wiring them to a screen without closing that first would
 * have shipped the hole, not the feature.
 *
 * users.id is the auth identity; users.brokerage_id is the tenant. Neither is
 * ever accepted from the caller.
 */
async function requireBrokerage(): Promise<
  { ok: true; userId: string; brokerageId: string } | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  // Destructure the error: a refused read must not read as "no brokerage".
  const { data: row, error } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (error) return { ok: false, error: `Could not resolve your brokerage: ${error.message}` }
  if (!row?.brokerage_id) return { ok: false, error: "Your account is not attached to a brokerage" }

  return { ok: true, userId: user.id, brokerageId: row.brokerage_id }
}

/**
 * Validate a buyer lifecycle state transition
 */
export async function validateBuyerStateTransition(params: {
  contactId: string
  currentState: BuyerState | null
  targetState: BuyerState
  userRole: string
  userId: string
  isAdminOverride?: boolean
  overrideReason?: string
}): Promise<TransitionValidationResult> {
  const { contactId, currentState, targetState, userRole, userId, isAdminOverride, overrideReason } =
    params

  // Validate inputs
  if (!isValidUUID(contactId)) {
    return { allowed: false, reason: "Invalid contact ID" }
  }

  if (!userId) {
    return { allowed: false, reason: "User ID required" }
  }

  // Perform validation
  return await validateStateTransition({
    contactId,
    currentState,
    targetState,
    userRole,
    userId,
    isAdminOverride,
    overrideReason,
  })
}

/**
 * Execute a validated state transition (emits event only)
 */
export async function executeBuyerStateTransition(params: {
  contactId: string
  fromState: BuyerState | null
  toState: BuyerState
  triggeredBy: "agent" | "system" | "ai_isa" | "voice"
  authorityRole: string
  userId: string
  sourceSystem: string
  brokerageId: string
  overrideReason?: string
  metadata?: Record<string, unknown>
}): Promise<{ success: boolean; error?: string; activityId?: string }> {
  const {
    contactId,
    fromState,
    toState,
    triggeredBy,
    authorityRole,
    userId,
    sourceSystem,
    brokerageId,
    overrideReason,
    metadata,
  } = params

  // Validate inputs
  if (!isValidUUID(contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  // Emit transition event
  return await emitLifecycleTransition({
    contactId,
    fromState,
    toState,
    triggeredBy,
    authorityRole,
    userId,
    sourceSystem,
    brokerageId,
    overrideReason,
    metadata,
  })
}

/**
 * Get buyer lifecycle history
 */
export async function getBuyerLifecycleHistory(params: {
  contactId: string
  limit?: number
  startDate?: Date
  endDate?: Date
}): Promise<LifecycleHistoryEntry[]> {
  const { contactId, limit, startDate, endDate } = params

  if (!isValidUUID(contactId)) {
    return []
  }

  return await getLifecycleHistory(contactId, { limit, startDate, endDate })
}

/**
 * Get current buyer state
 */
export async function getCurrentBuyerState(contactId: string): Promise<BuyerState | null> {
  if (!isValidUUID(contactId)) {
    return null
  }

  return await getStateFromHistory(contactId)
}

/**
 * Get next allowed states for buyer
 */
export async function getNextAllowedBuyerStates(params: {
  contactId: string
  userRole: string
}): Promise<BuyerState[]> {
  const { contactId, userRole } = params

  if (!isValidUUID(contactId)) {
    return []
  }

  const currentState = await getStateFromHistory(contactId)
  if (!currentState) {
    return []
  }

  return getNextAllowedStates(currentState, userRole)
}

/**
 * Validate rollback to ON_HOLD or DISENGAGED
 */
export async function validateBuyerRollback(params: {
  contactId: string
  targetState: "BUYER_ON_HOLD" | "BUYER_DISENGAGED"
  userRole: string
}): Promise<TransitionValidationResult> {
  const { contactId, targetState, userRole } = params

  if (!isValidUUID(contactId)) {
    return { allowed: false, reason: "Invalid contact ID" }
  }

  const currentState = await getStateFromHistory(contactId)
  if (!currentState) {
    return { allowed: false, reason: "Buyer state not found" }
  }

  return validateRollback(currentState, targetState, userRole)
}

/**
 * Validate reactivation from ON_HOLD or DISENGAGED
 */
export async function validateBuyerReactivation(params: {
  contactId: string
  targetState: BuyerState
  userRole: string
}): Promise<TransitionValidationResult> {
  const { contactId, targetState, userRole } = params

  if (!isValidUUID(contactId)) {
    return { allowed: false, reason: "Invalid contact ID" }
  }

  const currentState = await getStateFromHistory(contactId)
  if (!currentState || (currentState !== "BUYER_ON_HOLD" && currentState !== "BUYER_DISENGAGED")) {
    return { allowed: false, reason: "Buyer is not in ON_HOLD or DISENGAGED state" }
  }

  return await validateReactivation(currentState, targetState, contactId, userRole)
}

/**
 * GATING HELPERS
 */

/**
 * Check if buyer can search properties
 */
export async function canBuyerSearchProperties(contactId: string): Promise<GatingResult> {
  if (!isValidUUID(contactId)) {
    return { allowed: false, reason: "Invalid contact ID" }
  }

  return await isSearchAllowed(contactId)
}

/**
 * Check if buyer can schedule tours
 */
export async function canBuyerScheduleTours(contactId: string): Promise<GatingResult> {
  if (!isValidUUID(contactId)) {
    return { allowed: false, reason: "Invalid contact ID" }
  }

  return await isTourAllowed(contactId)
}

/**
 * Check if buyer can submit offers
 */
export async function canBuyerSubmitOffers(contactId: string): Promise<GatingResult> {
  if (!isValidUUID(contactId)) {
    return { allowed: false, reason: "Invalid contact ID" }
  }

  return await isOfferAllowed(contactId)
}

/**
 * Get all enabled gates for buyer
 */
export async function getBuyerEnabledGates(contactId: string): Promise<string[]> {
  if (!isValidUUID(contactId)) {
    return []
  }

  return await getEnabledGatesForBuyer(contactId)
}

// CONSOLIDATED AWAY — isBuyerGateEnabled({ contactId, gateName }): Promise<boolean>.
//
// Named survivor: app/actions/buyer-lifecycle-core.ts:getBuyerEnabledGates — same module,
// same input, already wired at app/crm/contacts/[contactId]/page.tsx:5, and it returns the
// WHOLE enabled-gate set instead of one yes/no.
//
// This is a merge, not a judgement call about usage. lib/buyer-lifecycle/lifecycle-definitions.ts
// defines isSystemGateEnabled(state, gate) as `getEnabledSystemGates(state).includes(gate)` —
// literally the survivor's answer, filtered. So `isBuyerGateEnabled({contactId, gateName})`
// === `(await getBuyerEnabledGates(contactId)).includes(gateName)`, with no branch, no read
// and no validation the survivor lacks. There was nothing to port: the deleted wrapper did
// strictly less with the same data.

/**
 * FINANCIAL VERIFICATION
 */

/**
 * Check buyer financial verification status
 */
export async function checkBuyerFinancialVerification(
  contactId: string
): Promise<FinancialVerificationResult> {
  if (!isValidUUID(contactId)) {
    return { isVerified: false, signals: [] }
  }

  return await checkFinancialVerification({ contactId })
}

/**
 * Get financial verification status summary
 */
export async function getBuyerFinancialStatus(
  contactId: string
): Promise<FinancialVerificationStatus> {
  if (!isValidUUID(contactId)) {
    return { status: "not_verified" } as unknown as FinancialVerificationStatus
  }

  return (await getFinancialVerificationStatus(contactId)) as unknown as FinancialVerificationStatus
}

/**
 * Emit financial verification event
 */
export async function recordBuyerFinancialVerification(params: {
  contactId: string
  verificationType: "preapproval" | "proof_of_funds" | "lender_intro" | "agent_confirmation"
  userId: string
  expiresAt?: Date
  metadata?: Record<string, unknown>
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, verificationType, userId, expiresAt, metadata } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  if (!userId) {
    return { success: false, error: "User ID required" }
  }

  // emitFinancialVerificationEvent uses a typed metadata schema (FinancialVerificationEventMetadata)
  // rather than a generic Record<string, unknown>. Caller-provided metadata fields are spread into
  // the known typed fields below. Fields that don't map to a typed param (e.g. arbitrary caller
  // keys) cannot be forwarded without a schema change — they are preserved in verificationNotes as
  // a JSON string so no caller data is silently dropped.
  const knownMetadataFields = {
    maxBudget: metadata?.max_budget as number | undefined,
    documentId: metadata?.document_id as string | undefined,
    lenderName: metadata?.lender_name as string | undefined,
    preApprovalAmount: metadata?.pre_approval_amount as number | undefined,
  }

  const reservedKeys = new Set(["max_budget", "document_id", "lender_name", "pre_approval_amount", "expires_at", "verification_type"])
  const extraMetadata = metadata
    ? Object.fromEntries(Object.entries(metadata).filter(([k]) => !reservedKeys.has(k)))
    : {}
  const verificationNotes =
    Object.keys(extraMetadata).length > 0 ? JSON.stringify(extraMetadata) : undefined

  return await emitFinancialVerificationEvent({
    contactId,
    verificationType,
    userId,
    expiresAt,
    status: "verified",
    verifiedBy: "agent",
    source: "manual",
    ...knownMetadataFields,
    ...(verificationNotes ? { verificationNotes } : {}),
  })
}

/**
 * STATISTICS & REPORTING
 */

/**
 * Buyer lifecycle statistics for the CALLER'S OWN brokerage.
 *
 * The tenant is resolved from the session — see requireBrokerage above for why
 * accepting it as an argument was an authorization hole against a service-role
 * reader.
 *
 * KNOWN LIMIT, stated rather than hidden: lib/buyer-lifecycle/lifecycle-logger.ts
 * :getLifecycleStatistics logs a failed read and returns a ZEROED result, so a
 * refused query and a brokerage with no buyers are indistinguishable from here.
 * That swallow lives outside this action and is reported, not papered over — the
 * surface must not phrase a zero as proof of "no buyers".
 */
export async function getBuyerLifecycleStatistics(params?: {
  startDate?: Date
  endDate?: Date
}): Promise<
  | { ok: true; brokerageId: string; statistics: LifecycleStatistics }
  | { ok: false; error: string }
> {
  const ctx = await requireBrokerage()
  if (!ctx.ok) return { ok: false, error: ctx.error }

  const statistics = await getLifecycleStatistics(ctx.brokerageId, {
    startDate: params?.startDate,
    endDate: params?.endDate,
  })

  return { ok: true, brokerageId: ctx.brokerageId, statistics }
}

/**
 * The contact ids of the caller's own buyers currently in one lifecycle state.
 *
 * Same tenancy rule as above. `state` is validated against the compiled state
 * table before it reaches the reader, so an unknown state name comes back as a
 * refusal rather than as an empty cohort that looks like "nobody is here".
 */
export async function getBuyersInSpecificState(params: {
  state: BuyerState
  limit?: number
}): Promise<
  | { ok: true; state: BuyerState; contactIds: string[] }
  | { ok: false; error: string }
> {
  const ctx = await requireBrokerage()
  if (!ctx.ok) return { ok: false, error: ctx.error }

  const { getStateDefinition } = await import("@/lib/buyer-lifecycle/lifecycle-definitions")
  if (!getStateDefinition(params.state)) {
    return { ok: false, error: `Unknown buyer lifecycle state: ${String(params.state)}` }
  }

  const contactIds = await getBuyersInState(ctx.brokerageId, params.state, {
    limit: params.limit,
  })

  return { ok: true, state: params.state, contactIds }
}
