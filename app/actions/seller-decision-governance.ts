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

import { evaluateDecisionReadiness, isDecisionReady, validateDecisionReversal, type DecisionReadinessInput } from "@/lib/seller-decision-governance/decision-readiness-engine"
import { evaluateCMAQuality, deriveCMAQualityFromEvents, type CMAQualityInput } from "@/lib/seller-decision-governance/cma-quality-evaluator"
import { validateNetSheetValidity, deriveNetSheetValidityFromEvents, emitNetSheetExpirationWarning, type NetSheetValidityInput } from "@/lib/seller-decision-governance/net-sheet-validator"
import { evaluatePresentationReadiness, derivePresentationReadinessFromEvents } from "@/lib/seller-decision-governance/presentation-readiness"
import { logDecisionTransition, logCMAQualityVerified, logNetSheetEvent, logPresentationEvent, logDecisionReversal, queryDecisionHistory, type DecisionTransitionEvent, type DecisionReversalEvent } from "@/lib/seller-decision-governance/decision-logger"
import { getAllStates, getMilestoneStates, getStateDefinition, type SellerDecisionState } from "@/lib/seller-decision-governance/decision-state-definitions"
import { isValidUUID } from "@/lib/validations"
import { createClient } from "@/lib/supabase/server"
import { readRoleGrants } from "@/lib/auth/role-grants"
import {
  isBrokerageFinanceAdmin,
  isBrokerageFinanceAdminGrantRole,
  type UserRole,
} from "@/lib/auth/resolve-user-role"

// ─── THE ACTOR IS RESOLVED HERE, NEVER ACCEPTED ──────────────────────────────
//
// Every action in this file used to take the acting role as an ARGUMENT. The one
// live caller (offers-manager-client) passed the string literal "agent" at all
// three of them, from a component that already held the real role in a prop — so
// a broker_owner's override was recorded as an agent's, and a client could have
// named any role it liked. An audit trail whose subject is supplied by the thing
// being audited is not an audit trail.
//
// These helpers derive the actor from the SESSION. `user_type` is the seat and a
// role GRANT adds capability on top of it (owner ruling), so both halves are
// read — the same two halves public.is_brokerage_finance_admin() reads, which is
// why the grant is PINNED to the caller's own brokerage exactly as the SQL pins
// it. A grant administering a different brokerage authorises nothing.
type Caller = { userId: string; brokerageId: string | null; userType: UserRole }

async function requireCaller(): Promise<{ ok: true; caller: Caller } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  // DESTRUCTURE THE ERROR: supabase-js RESOLVES a refused query, so `data` alone
  // reports "RLS denied this read" as "this user has no row" — which would then
  // be stamped into the audit trail as user_type 'agent'.
  const { data: u, error } = await supabase
    .from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (error) return { ok: false, error: `Could not read the caller's profile: ${error.message}` }
  if (!u) return { ok: false, error: "Unauthorized" }
  return {
    ok: true,
    caller: {
      userId: user.id,
      brokerageId: u.brokerage_id ?? null,
      userType: (u.user_type || "agent") as UserRole,
    },
  }
}

/**
 * The role this caller may override a seller-decision gate WITH, or null.
 *
 * A governance override here suppresses a failing check on the CMA and the net
 * sheet — the two documents the seller's money decision rests on — so m472 puts
 * it in the BROKERAGE-WIDE MONEY tier, which holds team_lead out. That judgement
 * lives in exactly one place (BROKERAGE_FINANCE_ADMIN_USER_TYPES); this function
 * only decides WHICH of the caller's two identities satisfies it.
 *
 * Returns the qualifying role rather than a boolean, because the qualifying role
 * is what gets written to the audit trail: an admin-by-grant overrode as 'admin',
 * and recording their user_type 'agent' instead would be a false record.
 */
async function resolveOverrideRole(
  caller: Caller,
): Promise<{ ok: true; role: UserRole | null } | { ok: false; error: string }> {
  // The pure half first — no I/O for the callers this already answers.
  if (isBrokerageFinanceAdmin({ user_type: caller.userType })) {
    return { ok: true, role: caller.userType }
  }
  // No tenant of their own → no grant can be pinned to one. Same as the SQL.
  if (!caller.brokerageId) return { ok: true, role: null }

  const supabase = await createClient()
  // NEVER .maybeSingle(): user_role_assignments is UNIQUE on (user_id, role), not
  // on user_id, and the second seat this exists to admit holds three grants.
  const res = await readRoleGrants(supabase, caller.userId)
  if (!res.ok) return { ok: false, error: res.error }

  const qualifying = res.grants.find(
    (g) => g.brokerage_id === caller.brokerageId && isBrokerageFinanceAdminGrantRole(g.role),
  )
  return { ok: true, role: qualifying ? (qualifying.role as UserRole) : null }
}

/**
 * Evaluate if listing is ready for a target decision state
 */
// The engine's own input type, MINUS the field a client may not assert.
//
// `overrideByRole` is not an input any more: the client says only WHETHER it is
// asking for an override, and the server decides with what authority. Taking the
// engine's type and subtracting one field keeps ONE definition of the rest of the
// shape — restating it is how the `broker_owner` gap opened here in the first
// place (a narrower union assigns cleanly to a wider one, so that one failed
// silently rather than at the compiler, refusing broker_owner at this boundary
// while the engine admitted them).
export async function evaluateSellerDecisionReadiness(
  input: Omit<DecisionReadinessInput, "overrideByRole"> & { requestOverride?: boolean },
) {
  try {
    if (!isValidUUID(input.listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }

    const { requestOverride, ...engineInput } = input
    let overrideByRole: UserRole | undefined

    if (requestOverride) {
      const auth = await requireCaller()
      if (!auth.ok) return { success: false, error: auth.error }
      const resolved = await resolveOverrideRole(auth.caller)
      // A REFUSED grant read is reported as a refusal, never as "not authorised" —
      // that would deny a legitimate finance admin for the wrong reason, invisibly.
      if (!resolved.ok) return { success: false, error: resolved.error }
      if (!resolved.role) {
        return {
          success: false,
          error:
            "Not authorised to override a seller-decision gate. Overriding the CMA or net-sheet " +
            "check is a brokerage-wide financial authority (broker, broker owner or admin).",
        }
      }
      overrideByRole = resolved.role
    }

    const result = await evaluateDecisionReadiness({ ...engineInput, overrideByRole })

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
// Takes the evaluator's OWN input type rather than restating it.
//
// This signature used to spell the shape out inline, and its `overrideByRole`
// union omitted `broker_owner` while CMAQualityInput's included it. One
// vocabulary, two copies, and only one of them got widened when the override
// became a real authority test (isBrokerageFinanceAdmin now judges this value) —
// so the person who OWNS the brokerage could not be recorded as the overrider of
// their own brokerage's CMA. Importing the type makes that class of drift
// impossible rather than merely fixed.
export async function evaluateListingCMAQuality(input: CMAQualityInput) {
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

// CONSOLIDATED AWAY — checkCMAReady(listingId).
//
// Named survivor: app/actions/seller-decision-governance.ts:evaluateListingCMAQuality —
// same module, same argument, already wired at
// app/dashboard/listings/[id]/offers/components/seller-decision-readiness-card.tsx:190.
//
// This is a merge and the port is a no-op by construction. lib/seller-decision-governance
// /cma-quality-evaluator.ts:isCMAReady IS `deriveCMAQualityFromEvents(listingId)` then
// `evaluateCMAQuality(input)` then `.isReady` — the survivor runs exactly those two steps
// and returns the whole result: isReady PLUS qualityScore, the four per-threshold checks,
// and the engine's own violations and warnings. The deleted wrapper's single boolean is a
// field of the survivor's return value, which is why the card had to invent causes
// ("comparable analysis may be missing or outdated") that no engine ever stated.

/**
 * Validate net sheet validity
 */
// Same as above: the validator's own input type, not a second copy of it.
export async function validateListingNetSheetValidity(input: NetSheetValidityInput) {
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

// CONSOLIDATED AWAY — checkNetSheetValid(listingId).
//
// Named survivor: app/actions/seller-decision-governance.ts:validateListingNetSheetValidity —
// same module, same argument, already wired at
// app/dashboard/listings/[id]/offers/components/seller-decision-readiness-card.tsx:191.
//
// lib/seller-decision-governance/net-sheet-validator.ts:isNetSheetValid IS
// `deriveNetSheetValidityFromEvents` then `validateNetSheetValidity` then `.isValid`. The
// survivor runs the same two steps, returns isValid PLUS isExpired, daysRemaining and the
// validator's warnings, and does one thing more the wrapper never did: when the sheet is
// inside its last seven days it emits seller.net_sheet.expiration_warning. Deleting the
// wrapper removes a boolean; nothing that only the wrapper could do exists.

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

// CONSOLIDATED AWAY — checkPresentationReady(listingId).
//
// Named survivor: app/actions/seller-decision-governance.ts:evaluateListingPresentationReadiness —
// same module, same argument, already wired at
// app/dashboard/listings/[id]/offers/components/seller-decision-readiness-card.tsx:192.
//
// lib/seller-decision-governance/presentation-readiness.ts:isPresentationReady IS
// `derivePresentationReadinessFromEvents` then `evaluatePresentationReadiness` then
// `.presentationReady`. The survivor returns that flag PLUS videoReady, the three
// per-condition checks and the engine's warnings — and it keeps "no presentation data
// found" distinct from "not ready", which the deleted wrapper collapsed into a plain
// false. The distinction is the point: one is a finding about the listing, the other is
// the engine saying it could not evaluate.

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
// authority_role is SUBTRACTED, not accepted — see requireCaller's header. The
// one live caller passed the literal "agent" from a component holding the real
// role in a prop, so every transition in this audit trail claimed an agent made
// it. The seat is now stamped from the session.
export async function logSellerDecisionTransition(input: Omit<DecisionTransitionEvent, "authority_role">) {
  try {
    if (!isValidUUID(input.listing_id)) {
      return { success: false, error: "Invalid listing ID" }
    }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    // RELAY THE REAL ANSWER. This used to `await` a void and then assert
    // { success: true } — the loggers swallowed both the listing read and the
    // insert, so the action reported a written audit row over an RLS refusal.
    const wrote = await logDecisionTransition({ ...input, authority_role: auth.caller.userType })
    if (!wrote.ok) return { success: false, error: wrote.error }

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
    
    const wrote = await logCMAQualityVerified(input)
    if (!wrote.ok) return { success: false, error: wrote.error }

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
    
    const wrote = await logNetSheetEvent(input)
    if (!wrote.ok) return { success: false, error: wrote.error }

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
    
    const wrote = await logPresentationEvent(input)
    if (!wrote.ok) return { success: false, error: wrote.error }

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
// Same subtraction as logSellerDecisionTransition, and for the same reason: the
// reversal's authority_role was the literal "agent" at its one call site.
export async function logSellerDecisionReversal(input: Omit<DecisionReversalEvent, "authority_role">) {
  try {
    if (!isValidUUID(input.listing_id)) {
      return { success: false, error: "Invalid listing ID" }
    }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const wrote = await logDecisionReversal({ ...input, authority_role: auth.caller.userType })
    if (!wrote.ok) return { success: false, error: wrote.error }

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
