'use server'

/**
 * SYSTEM 5.1 - BUYER CORE EXECUTION ENGINE
 * Server actions for buyer journey execution
 * 
 * Powers:
 * - Buyer journey status and progress bars
 * - Financial gate enforcement
 * - Voice assistant integration
 * - Multi-party updates (agent, lender, admin)
 * - Journey transparency and education
 */

import { isValidUUID } from '@/lib/validations'
import { handleError } from '@/lib/errors'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getBuyerJourneyStatus,
  enforceFinancialGate,
  getBuyerFriendlyMessage,
  logBuyerExecutionEvent,
  handleBuyerVoiceRequest,
  lenderConfirmFinancialVerification,
  agentAssistSearchConfiguration,
  adminOverrideFinancialGate,
  resolveFinancialGateOverrideAuthority,
  agentAdvanceBuyerStage,
  getMultiPartyUpdateHistory,
  type BuyerExecutionContext,
  type VoiceAssistantRequest,
} from '@/lib/buyer-execution'
// The canonical "may this caller act on this contact?" gate. It admits the
// contact THEMSELVES (linked user id or matching email) as well as same-brokerage
// staff, which is exactly the audience this file's `source: 'buyer_portal'` path
// was written for — so gating on it does not close the buyer portal, it is the
// thing the buyer portal was already supposed to be going through.
// Deliberately NOT `assertCanActOnContact` (lib/auth/contact-access.ts): that one
// is staff-only and would lock the buyer out of their own journey.
//
// It also resolves the TENANT FROM THE CONTACT ROW (contacts.brokerage_id) and
// compares it to the caller's own brokerage — which is the mechanical form of the
// owner's ruling: "can only get their contacts".
import { requireContactAccess } from '@/lib/portal/require-contact-access'

// ─────────────────────────────────────────────────────────────────────────────
// WAVE 3 — THE ACTOR IS THE SESSION, NEVER A PARAMETER.
//
// The owner's ruling:
//
//   "can only get their contacts but anytime there is someone using voice, they are
//    not going to know what their id is so there has to be another way to check who
//    the user is."
//
// Every export in this module is a `'use server'` action, i.e. its own public HTTP
// endpoint. Six of them used to take the acting party's id — `userId`, `agentId`,
// `lenderId`, `adminId` — straight off the wire, with nothing but `isValidUUID()` in
// front. A caller declared who they were and the system believed them. Worse for
// voice: a person speaking to an assistant has no idea what their uuid is, so the
// only way an id could ever have reached these was for something upstream to make one
// up or for the model to hallucinate one out of the sentence.
//
// Now: `requireContactAccess(contactId)` establishes BOTH facts at once — who the
// caller actually is (from the Supabase session) and whether this contact is inside
// their tenant (from the contact's own brokerage_id). The actor ids below are taken
// from that result. The `userId` / `agentId` / `lenderId` / `adminId` parameters are
// RETAINED on the signatures so existing call sites keep typechecking, and are
// documented as ignored — the house pattern already used by
// `handleBuyerVoiceAssistant` and `logBuyerAction` in this same file.
//
// THE UNATTENDED LANE IS NOT BROKEN BY THIS. `app/api/agent-assistant/tool-call/
// route.ts` is the ElevenLabs voice webhook: no cookie session, authenticated by a
// shared secret, speaker resolved from an `agent_assistant_sessions` row. A cookie
// gate here would have turned it away. It has been given its own door onto the
// `lib/buyer-execution` functions instead, carrying its REAL session-resolved actor —
// the same pattern that file already documents for `query_listing_status`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get buyer's complete journey status
 * Powers buyer portal, progress bars, and agent dashboards
 *
 * GATED (was not). This is the read the ruling names directly — "can only get their
 * contacts". It was a public endpoint keyed on a bare `contactId` with a
 * caller-supplied `userId`, and the engine underneath reads through
 * `createServiceClient()`, so RLS was not in play either: knowing (or guessing) a
 * contact uuid returned that buyer's stage, their financial-verification posture, and
 * what gates they have cleared, from ANY brokerage.
 *
 * The tenant is now resolved FROM the contact row and compared to the caller's, and
 * `userId` is taken from the session.
 */
export async function getBuyerJourney(params: {
  contactId: string
  /** Ignored — the actor is derived from the session. */
  userId?: string
  source?: 'buyer_portal' | 'agent_action' | 'voice_assistant'
}) {
  const { contactId, source = 'buyer_portal' } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) return { success: false, error: access.error }

  try {
    const context: BuyerExecutionContext = {
      contactId,
      userId: access.userId,
      source
    }

    const result = await getBuyerJourneyStatus(context)

    if (!result.success || !result.status) {
      return { success: false, error: result.error || 'Failed to get journey status' }
    }

    const friendlyMessage = getBuyerFriendlyMessage(result.status)

    return {
      success: true,
      journey: result.status,
      message: friendlyMessage
    }
  } catch (error) {
    console.error('[buyer-execution] Error in getBuyerJourney:', error)
    return handleError(error, 'getBuyerJourney')
  }
}

/**
 * Check if buyer can perform a specific action
 * Called before search, tour, or offer actions
 *
 * GATED (was not). It both READ a buyer's financial-verification posture across the
 * tenant boundary and WROTE a `buyer.<action>.blocked` activity row attributed to a
 * caller-declared `userId` — a read leak and a log-forgery primitive in one endpoint.
 * Both ends now come from the session.
 */
export async function checkBuyerCanPerformAction(params: {
  contactId: string
  action: 'search' | 'tour' | 'offer'
  /** Ignored — the actor is derived from the session. */
  userId?: string
}) {
  const { contactId, action } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) return { success: false, error: access.error }

  try {
    const context: BuyerExecutionContext = {
      contactId,
      userId: access.userId,
      source: 'buyer_portal'
    }

    const gateCheck = await enforceFinancialGate(context, action)

    if (!gateCheck.allowed) {
      // Log blocked attempt
      await logBuyerExecutionEvent({
        contactId,
        eventType: `buyer.${action}.blocked`,
        userId: access.userId,
        source: 'buyer_portal',
        metadata: {
          reason: gateCheck.reason,
          verification_status: gateCheck.verification?.isVerified || false
        }
      })
    }

    return {
      success: true,
      allowed: gateCheck.allowed,
      reason: gateCheck.reason,
      verification: gateCheck.verification
    }
  } catch (error) {
    console.error('[buyer-execution] Error in checkBuyerCanPerformAction:', error)
    return handleError(error, 'checkBuyerCanPerformAction')
  }
}

/**
 * Voice assistant endpoint
 * Handles all buyer voice interactions
 *
 * GATED (was not). `"use server"` makes this a public HTTP endpoint and it had no
 * session at all: `contactId` AND the acting `userId` both came from the caller.
 * So anyone could (a) drive the assistant against any contact in any brokerage —
 * `explain_progress` reads that buyer's journey status and speaks it back,
 * including their financial-verification posture — and (b) stamp the resulting
 * `buyer.voice.interaction` activity row with **any user id they liked**, forging
 * the audit trail.
 *
 * `userId` is now ignored and taken from the session, so the interaction log
 * records who actually called.
 *
 * WIRED (orphan burn-down). Gated in a previous wave and then left with no caller at
 * all — the buyer-facing assistant existed only as an endpoint. Its surface is now
 * app/portal/[contactId]/assistant/page.tsx + buyer-assistant-client.tsx, in the
 * buyer's own portal, which is the audience `requireContactAccess` was chosen for:
 * it admits the CONTACT themselves (linked user id or matching email) as well as
 * same-brokerage staff, unlike the staff-only assertCanActOnContact.
 *
 * The client sends `contactId`, `intent` and `transcript` and NOTHING ELSE — the
 * ignored `userId` parameter is not passed at all rather than passed and discarded,
 * so no surface in the tree even looks like it supplies the actor. Typed transcript
 * first: a browser speech layer produces the same two fields and needs no change to
 * this contract.
 */
export async function handleBuyerVoiceAssistant(params: {
  contactId: string
  intent: 'explain_progress' | 'whats_next' | 'search_properties' | 'schedule_tour' | 'general_question'
  transcript: string
  /** Ignored — the actor is derived from the session. */
  userId?: string
}) {
  const { contactId, intent, transcript } = params

  if (!isValidUUID(contactId)) {
    return {
      success: false,
      spokenResponse: 'I had trouble identifying your account. Please try again.'
    }
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) {
    return {
      success: false,
      spokenResponse: 'I had trouble identifying your account. Please try again.',
      error: access.error,
    }
  }

  try {
    const request: VoiceAssistantRequest = {
      contactId,
      intent,
      transcript,
      userId: access.userId,
    }

    return await handleBuyerVoiceRequest(request)
  } catch (error) {
    console.error('[buyer-execution] Error in handleBuyerVoiceAssistant:', error)
    return {
      success: false,
      spokenResponse: 'I encountered an error. Please contact your agent for assistance.',
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Lender confirms buyer financial verification
 * LENDER ROLE ONLY
 *
 * GATED (was not). `lenderId` came off the wire, so a caller could flip a buyer's
 * financing gate and attribute it to any lender they named. The lender is now the
 * session user; `lenderConfirmFinancialVerification` still independently proves that
 * user is a lender/vendor AND is assigned to this contact with 'financial' scope
 * (assertVendorAssignedToContact), so the session is a necessary but not sufficient
 * condition — which is the correct shape for a gate that moves money-adjacent state.
 *
 * NOTE: a lender is not "same-brokerage staff", so the vendor case reaches this
 * through `requireContactAccess`'s staff branch only when the vendor user carries a
 * brokerage; the assignment check inside the lib function is the real authority and it
 * is unchanged. The ElevenLabs webhook's lender lane does NOT come through here — see
 * app/api/agent-assistant/tool-call/route.ts, which calls the lib function directly.
 */
export async function lenderConfirmBuyerFinancials(params: {
  contactId: string
  /** Ignored — the lender is derived from the session. */
  lenderId?: string
  verificationType: 'preapproval' | 'proof_of_funds' | 'lender_intro'
  approvedAmount?: number
  loanType?: string
  interestRate?: number
  lenderName?: string
  expiresAt?: Date
  notes?: string
}) {
  const { contactId, verificationType, approvedAmount, loanType, interestRate, lenderName, expiresAt, notes } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) return { success: false, error: access.error }

  try {
    return await lenderConfirmFinancialVerification({
      contactId,
      lenderId: access.userId,
      verificationType,
      expiresAt,
      metadata: {
        approvedAmount,
        loanType,
        interestRate,
        lenderName,
        notes
      }
    })
  } catch (error) {
    console.error('[buyer-execution] Error in lenderConfirmBuyerFinancials:', error)
    return handleError(error, 'lenderConfirmBuyerFinancials')
  }
}

/**
 * Agent configures buyer search preferences
 * AGENT ROLE
 *
 * GATED (was not). `agentId` — actually a `users.id` despite the name, see
 * agentAdvanceBuyer below — was caller-supplied, so anyone could rewrite any buyer's
 * search criteria in any brokerage and stamp it on an agent who never touched it.
 */
export async function agentConfigureBuyerSearch(params: {
  contactId: string
  /** Ignored — the acting agent is derived from the session. */
  agentId?: string
  searchPreferences: {
    minPrice?: number
    maxPrice?: number
    minBeds?: number
    maxBeds?: number
    minBaths?: number
    cities?: string[]
    propertyTypes?: string[]
    features?: string[]
  }
  notes?: string
}) {
  const { contactId, searchPreferences, notes } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) return { success: false, error: access.error }
  // The contact themselves is not an agent. requireContactAccess admits them (by
  // design — it powers the buyer portal), so this write needs the staff branch.
  if (access.isContactSelf) {
    return { success: false, error: 'Only your agent can configure your search criteria' }
  }

  try {
    return await agentAssistSearchConfiguration({
      contactId,
      agentId: access.userId,
      searchPreferences,
      notes
    })
  } catch (error) {
    console.error('[buyer-execution] Error in agentConfigureBuyerSearch:', error)
    return handleError(error, 'agentConfigureBuyerSearch')
  }
}

/**
 * Admin/Broker override financial gate
 * ADMIN/BROKER ROLE ONLY - Emergency use
 *
 * THE SHARPEST EDGE IN THIS FILE, AND THE ONE THE RULING WAS WRITTEN ABOUT. This is
 * the endpoint reachable from the voice lane as `admin_override_financial_gate`, and
 * COMMAND_MAP maps the voice `user_id` straight onto `adminId`. Before wave 3 the
 * whole chain was caller-declared: an unauthenticated POST — or a uuid the intent
 * parser lifted out of a spoken sentence — became "the admin", and the buyer financial
 * gate came off.
 *
 * Two independent facts are now required, because a session alone is NOT authority to
 * override a financial gate:
 *
 *   1. The caller has a session AND this contact is in their tenant
 *      (requireContactAccess resolves the brokerage from the CONTACT row).
 *   2. That same session user holds an ADMITTED user_type, checked against an explicit
 *      allow-list. Checked here from the user_type requireContactAccess already
 *      resolved, and checked AGAIN inside adminOverrideFinancialGate against a
 *      user_type that function re-reads from the database itself.
 *
 * WAVE 5 — OWNER RULING: "admin or agent can override the finiancing gate".
 *
 * `agent` is admitted, scoped to THE AGENT OF RECORD ON THAT CONTACT rather than to any
 * agent in the brokerage. requireContactAccess proves tenancy, not relationship — its
 * staff branch lets every agent in the brokerage through — so the loose reading would
 * hand any agent the power to lift the financing gate of a buyer they have never met.
 * The voice lane already draws the line in the same place. The rule itself lives in ONE
 * place, lib/buyer-execution/multi-party-updates.ts, so the two layers cannot drift.
 *
 * THE SELF-OVERRIDE HAZARD. requireContactAccess deliberately admits the CONTACT
 * THEMSELVES (linked user id OR matching email), and it returns on that branch BEFORE
 * the staff test — so `isContactSelf` can be true while the caller carries a staff
 * user_type, whenever a contacts row shares their email address. Authority is therefore
 * an explicit ALLOW-LIST of staff user_types ANDed with a refusal of self, never
 * "not a contact": a negation would silently admit every user_type added later.
 *
 * `adminId` is retained on the signature and ignored.
 */
export async function adminOverrideFinancialVerification(params: {
  contactId: string
  /** Ignored — the admin is derived from the session and their role is verified. */
  adminId?: string
  reason: string
  expiresAt?: Date
}) {
  const { contactId, reason, expiresAt } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  if (!reason || reason.length < 10) {
    return { success: false, error: 'Detailed reason required for override (minimum 10 characters)' }
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) return { success: false, error: access.error }

  // The buyer never lifts their own gate. Checked FIRST and independently of user_type,
  // because requireContactAccess's self branch short-circuits its own staff test — so a
  // staff user_type on a self-matched caller proves nothing here.
  if (access.isContactSelf) {
    return { success: false, error: 'You cannot override your own financial gate' }
  }

  // Being able to SEE this contact is not permission to lift their financing gate.
  // The allow-list (and the agent-of-record scoping) lives in the lib module so this
  // layer and the lib layer enforce ONE rule; the user_type read is still independent
  // — this one comes from the session via requireContactAccess, the lib one from a
  // fresh `users` read. user_type is the canonical column; `role` is retired.
  const supabase = createServiceClient()
  const authority = await resolveFinancialGateOverrideAuthority(supabase, {
    userId: access.userId,
    userType: access.userType,
    contactId,
  })
  if (!authority.allowed) {
    return { success: false, error: authority.error }
  }

  try {
    return await adminOverrideFinancialGate({
      contactId,
      adminId: access.userId,
      reason,
      expiresAt
    })
  } catch (error) {
    console.error('[buyer-execution] Error in adminOverrideFinancialVerification:', error)
    return handleError(error, 'adminOverrideFinancialVerification')
  }
}

/**
 * Agent advances buyer to next stage
 * AGENT ROLE
 *
 * GATED (was not). Caller named the contact, the target lifecycle state, AND the agent
 * it was attributed to.
 *
 * `agentId` is a `users.id`, NOT an `agents.id`, despite the name — traced end to end:
 * app/crm/contacts/[contactId]/page.tsx:396 passes `agentUserId={user.id}` from
 * `auth.getUser()` → buyer-overview-client.tsx:671 `agentId={agentUserId}` →
 * buyer-stage-progress.tsx `agentAdvanceBuyer({ agentId })` → agentAdvanceBuyerStage
 * looks it up in `users`. So substituting the session's `users.id` preserves the
 * existing semantics exactly; no id space is crossed. The parameter stays on the
 * signature so the client component keeps typechecking, and is ignored.
 */
export async function agentAdvanceBuyer(params: {
  contactId: string
  /** Ignored — the acting agent (a users.id) is derived from the session. */
  agentId?: string
  targetState: string
  reason?: string
}) {
  const { contactId, targetState, reason } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) return { success: false, error: access.error }
  // A buyer advancing their own lifecycle stage would defeat the gates entirely.
  if (access.isContactSelf) {
    return { success: false, error: 'Only your agent can advance your stage' }
  }

  try {
    return await agentAdvanceBuyerStage({
      contactId,
      agentId: access.userId,
      targetState,
      reason
    })
  } catch (error) {
    console.error('[buyer-execution] Error in agentAdvanceBuyer:', error)
    return handleError(error, 'agentAdvanceBuyer')
  }
}

/**
 * Get multi-party update audit trail
 * Shows all agent, lender, and admin actions
 *
 * GATED (was not) — and this one bypassed RLS. `"use server"` + no session, and
 * the helper it delegates to (`lib/buyer-execution/multi-party-updates.ts:
 * getMultiPartyUpdateHistory`) reads `activities` through
 * `createServiceClient()`, filtered on `entity_id = contactId` **alone**. Service
 * role means the database's own tenant policies were not in play, so the only
 * thing standing between a caller and any buyer's financial audit trail —
 * `buyer.financial.lender_confirmed`, `buyer.financial.gate_overridden`,
 * `buyer.lifecycle.agent_advanced`, each with actor and metadata — was knowing a
 * contact uuid. Same shape as the wave-1 `batchEvaluateLeadReadiness` finding:
 * a service-client read scoped on a caller-supplied id.
 *
 * `limit` is also clamped now; it was passed straight through to `.limit()`.
 */
export async function getBuyerUpdateHistory(params: {
  contactId: string
  limit?: number
}) {
  const { contactId } = params
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? 50) || 50, 1), 200)

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) return { success: false, error: access.error }

  try {
    return await getMultiPartyUpdateHistory({
      contactId,
      limit
    })
  } catch (error) {
    console.error('[buyer-execution] Error in getBuyerUpdateHistory:', error)
    return handleError(error, 'getBuyerUpdateHistory')
  }
}

// `logBuyerAction({ contactId, actionType, source, metadata })` — DELETED
// (orphan burn-down, category C).
//
// SURVIVOR: `lib/buyer-execution/buyer-execution-engine.ts:317
// logBuyerExecutionEvent(...)`, which is the function this delegated to
// unchanged and which is LIVE at three call sites that write the buyer trail as
// it actually happens:
//   lib/buyer-execution/voice-assistant-integration.ts:48
//   lib/buyer-execution/showing-financial-policy.ts:157
//   lib/buyer-execution/multi-party-updates.ts (each gate transition)
// It resolves the tenant off the contact and returns {success,error} — nothing
// this wrapper added was carried in the write itself.
//
// What the wrapper added was a `"use server"` DOOR onto the audit log, and no
// caller ever walked through it. A generic event writer reachable over HTTP is
// worth having only if something needs to reach it from a browser; nothing does.
// The events an agent can trigger are each written by the action that performs
// them — lenderConfirmBuyerFinancials, adminOverrideFinancialVerification,
// agentAdvanceBuyer, agentConfigureBuyerSearch, all in this file — and those are
// the rows `getBuyerUpdateHistory` reads back on the contact page. There is no
// buyer event whose only route to `activities` was this endpoint.
//
// NOTE: the gate and the `^buyer\.` vocabulary clamp this carried are NOT lost
// capability — they existed solely to make the door safe. With the door closed
// the writes all originate server-side from actions that have already resolved
// their own actor, which is the stronger position.
