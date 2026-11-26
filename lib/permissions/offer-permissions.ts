/**
 * Offer Permission Guards
 * 
 * This module provides permission checking functions for offer-related
 * operations. These are pure functions that take the current state and
 * return boolean results with optional error messages.
 */

import type { Offer, OfferStatus, Contact } from "../domain/types"

// ============================================
// TYPES
// ============================================

export interface PermissionCheckResult {
  allowed: boolean
  reason?: string
}

export interface CanCreateOfferParams {
  agent_id: string
  contact?: Contact | null
  listing_id?: string
  user_role?: string
}

export interface CanSendOfferForSignatureParams {
  offer: Offer
  agent_id: string
  user_role?: string
}

export interface CanCounterOfferParams {
  offer: Offer
  party: "buyer" | "seller"
  agent_id: string
  user_role?: string
}

// ============================================
// PERMISSION GUARDS
// ============================================

/**
 * Checks if an agent can create a new offer
 * 
 * Requirements:
 * - Agent must be authenticated (has agent_id)
 * - If contact is provided, contact must belong to agent
 * - Agent cannot be deleted/suspended (basic role check)
 * 
 * @param params - Parameters for permission check
 * @returns Permission check result
 */
export function canCreateOffer(params: CanCreateOfferParams): PermissionCheckResult {
  const { agent_id, contact, user_role } = params

  // Must have agent_id
  if (!agent_id) {
    return {
      allowed: false,
      reason: "Agent authentication required to create offers",
    }
  }

  // Check if agent has required role
  if (user_role && ["suspended", "deleted"].includes(user_role.toLowerCase())) {
    return {
      allowed: false,
      reason: "Account status does not permit creating offers",
    }
  }

  // If contact provided, verify ownership
  if (contact) {
    // Contact must belong to this agent. `contacts.agent_id` is the ONE
    // assignment column; the `|| contact.assigned_agent_id === agent_id` escape
    // that stood here compared against a PHANTOM (no such column on live
    // contacts — tombstone at lib/domain/types.ts Contact, survivor
    // contacts.agent_id), so it was always `undefined !== agent_id` and never
    // admitted anyone. Removing it changes no verdict.
    if (contact.agent_id !== agent_id) {
      return {
        allowed: false,
        reason: "Cannot create offer for contact assigned to another agent",
      }
    }

    // Contact must not be deleted
    if (contact.deleted_at) {
      return {
        allowed: false,
        reason: "Cannot create offer for deleted contact",
      }
    }

    // Contact should be at appropriate stage (optional check - can be made stricter).
    // 2026-08-31: 'appointment_booked'/'signed_agreement'/'active_listing'/
    // 'contingent' removed — journey-ladder spellings no writer ever stored on
    // contacts.status and the m587 CHECK does not admit, so with them in the
    // list this advisory would have warned on EVERY legitimately 'active'
    // contact. Deal readiness is buyer_stage/transactions territory; the status
    // half of "appropriate" is: being worked or earned-qualified. Vocabulary:
    // lib/contact-promotion/qualification.ts CONTACT_STATUSES.
    const validStatuses: string[] = [
      "qualified",
      "active",
    ]
    
    if (!validStatuses.includes(contact.status)) {
      // This is a warning, not a hard block - allow but note it
      console.warn(
        `[canCreateOffer] Creating offer for contact in '${contact.status}' status. ` +
        `Typically offers are created for: ${validStatuses.join(", ")}`
      )
    }
  }

  return { allowed: true }
}

/**
 * Checks if an offer can be sent for signature
 * 
 * Requirements:
 * - Offer must be in a sendable status (draft, pending_review, ready_to_send)
 * - Offer must have required fields filled
 * - Offer must belong to the agent
 * - Offer must not be expired
 * - Offer must not already be sent/signed
 * 
 * @param params - Parameters for permission check
 * @returns Permission check result
 */
export function canSendOfferForSignature(params: CanSendOfferForSignatureParams): PermissionCheckResult {
  const { offer, agent_id, user_role } = params

  // Must have agent_id
  if (!agent_id) {
    return {
      allowed: false,
      reason: "Agent authentication required",
    }
  }

  // Offer must belong to agent
  if (offer.agent_id !== agent_id) {
    return {
      allowed: false,
      reason: "Cannot send offer created by another agent",
    }
  }

  // Check agent role
  if (user_role && ["suspended", "deleted"].includes(user_role.toLowerCase())) {
    return {
      allowed: false,
      reason: "Account status does not permit sending offers",
    }
  }

  // Check offer status - must be in sendable state
  const sendableStatuses: OfferStatus[] = ["draft", "pending_review", "ready_to_send"]
  if (!sendableStatuses.includes(offer.status)) {
    return {
      allowed: false,
      reason: `Cannot send offer with status '${offer.status}'. Offer must be in draft, pending review, or ready to send.`,
    }
  }

  // Check if offer is expired
  if (offer.expiration_date) {
    const expirationDate = new Date(offer.expiration_date)
    const now = new Date()
    if (expirationDate < now) {
      return {
        allowed: false,
        reason: "Cannot send expired offer",
      }
    }
  }

  // Check if offer already sent
  if (offer.sent_for_signature_at) {
    return {
      allowed: false,
      reason: "Offer has already been sent for signature",
    }
  }

  // Validate required fields
  if (!offer.property_address) {
    return {
      allowed: false,
      reason: "Property address is required before sending",
    }
  }

  if (!offer.offer_price || offer.offer_price <= 0) {
    return {
      allowed: false,
      reason: "Valid offer price is required before sending",
    }
  }

  if (!offer.buyer_name && !offer.contact_id) {
    return {
      allowed: false,
      reason: "Buyer information is required before sending",
    }
  }

  if (!offer.closing_date) {
    return {
      allowed: false,
      reason: "Closing date is required before sending",
    }
  }

  return { allowed: true }
}

/**
 * Checks if a party can submit a counter-offer
 * 
 * Requirements:
 * - Offer must be in a counterable status
 * - Party must have permission to counter (buyer or seller)
 * - Offer must not be expired
 * - Agent must represent the party making the counter
 * - Cannot counter own offer
 * 
 * @param params - Parameters for permission check
 * @returns Permission check result
 */
export function canCounterOffer(params: CanCounterOfferParams): PermissionCheckResult {
  const { offer, party, agent_id, user_role } = params

  // Must have agent_id
  if (!agent_id) {
    return {
      allowed: false,
      reason: "Agent authentication required",
    }
  }

  // Check agent role
  if (user_role && ["suspended", "deleted"].includes(user_role.toLowerCase())) {
    return {
      allowed: false,
      reason: "Account status does not permit countering offers",
    }
  }

  // Check offer status - must be in counterable state
  const counterableStatuses: OfferStatus[] = [
    "sent_for_signature",
    "partially_signed",
    "fully_signed",
    "countered",
  ]
  
  if (!counterableStatuses.includes(offer.status)) {
    return {
      allowed: false,
      reason: `Cannot counter offer with status '${offer.status}'. Offer must be sent, signed, or previously countered.`,
    }
  }

  // Check if offer is expired
  if (offer.expiration_date) {
    const expirationDate = new Date(offer.expiration_date)
    const now = new Date()
    if (expirationDate < now) {
      return {
        allowed: false,
        reason: "Cannot counter expired offer",
      }
    }
  }

  // Check if offer is already accepted
  if (offer.status === "accepted" || offer.accepted_at) {
    return {
      allowed: false,
      reason: "Cannot counter an accepted offer",
    }
  }

  // Check if offer is already converted to transaction
  if (offer.transaction_id || offer.converted_to_transaction_at) {
    return {
      allowed: false,
      reason: "Cannot counter offer that has been converted to a transaction",
    }
  }

  // Party validation
  if (!["buyer", "seller"].includes(party)) {
    return {
      allowed: false,
      reason: "Counter offers can only be submitted by buyer or seller",
    }
  }

  // Agent authorization check
  // Note: In a real system, you'd check if the agent represents the party
  // For now, we verify the agent isn't countering their own offer inappropriately
  if (offer.agent_id === agent_id && party === "buyer") {
    // Agent created the offer, likely representing buyer
    // Cannot counter as buyer if they created the original offer
    // (though they could if representing seller in this scenario)
    console.warn(
      `[canCounterOffer] Agent ${agent_id} attempting to counter as buyer on their own offer ${offer.id}. ` +
      `Verify agent is authorized to represent this party.`
    )
  }

  return { allowed: true }
}

/**
 * Helper function to check if an offer can be edited
 * 
 * @param offer - The offer to check
 * @param agent_id - The agent attempting the edit
 * @returns Permission check result
 */
export function canEditOffer(offer: Offer, agent_id: string): PermissionCheckResult {
  // Can only edit own offers
  if (offer.agent_id !== agent_id) {
    return {
      allowed: false,
      reason: "Cannot edit offer created by another agent",
    }
  }

  // Can only edit drafts or pending review
  const editableStatuses: OfferStatus[] = ["draft", "pending_review", "ready_to_send"]
  if (!editableStatuses.includes(offer.status)) {
    return {
      allowed: false,
      reason: `Cannot edit offer with status '${offer.status}'`,
    }
  }

  return { allowed: true }
}

/**
 * Helper function to check if an offer can be deleted/withdrawn
 * 
 * @param offer - The offer to check
 * @param agent_id - The agent attempting the deletion
 * @returns Permission check result
 */
export function canWithdrawOffer(offer: Offer, agent_id: string): PermissionCheckResult {
  // Can only withdraw own offers
  if (offer.agent_id !== agent_id) {
    return {
      allowed: false,
      reason: "Cannot withdraw offer created by another agent",
    }
  }

  // Cannot withdraw accepted offers or those converted to transactions
  if (offer.status === "accepted" || offer.transaction_id) {
    return {
      allowed: false,
      reason: "Cannot withdraw accepted offer or offer converted to transaction",
    }
  }

  return { allowed: true }
}
