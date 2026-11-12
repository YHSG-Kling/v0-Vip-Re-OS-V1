/**
 * Offer Lifecycle Functions
 * 
 * This module provides lifecycle management functions for offers and related
 * entities. These functions handle state transitions, data transformations,
 * and integration with external systems.
 * 
 * NOTE: These are business logic functions. They do NOT include database operations.
 * Callers are responsible for persisting changes.
 */

import type {
  Contact,
  Offer,
  OfferVersion,
  OfferCreationResult,
} from "../domain/types"
import { canCreateOffer } from "../permissions/offer-permissions"

// ─────────────────────────────────────────────────────────────────────────────
// TOMBSTONE (§1.3) — the LEAD-PROMOTION half of this file is DELETED.
//
// promoteLeadToContact and its six private derivation helpers
// (deriveContactTypeFromIntent, deriveContactPersona, deriveTimelineFromLead,
// deriveContactStatus, mapLeadSourceToContactSource, buildPromotionNotes)
// stood here. SURVIVOR: lib/contact-promotion/promote-lead-to-contact.ts
// :28 promoteLeadToContactService — the live, session-gated, history-carrying
// promotion door, exported through lib/contact-promotion/index.ts:14 and pinned
// by scripts/conversion-finality-simulator.ts:319. Nothing anywhere imported
// THIS module (verified repo-wide, 2026-08-31): the only in-tree mentions were
// prose and its own baseline entry, so this was a second, unreached spelling of
// a door that already exists — the §6 defect at module scale.
//
// And it was not merely redundant, it was WRONG twice over, which is why no
// part of it was merged onto the survivor:
//   · deriveContactPersona emitted the RETIRED 16-value persona union
//     (first_time_buyer, motivated_seller, upsizers, …). The live
//     contacts_contact_persona_check admits none of those spellings, and a
//     CHECK refusal (23514) rejects the WHOLE row (§3) — had this path ever
//     gone live, every promotion through it would have silently produced no
//     contact.
//   · deriveContactStatus mapped lead statuses onto contact statuses by
//     guesswork; the live door derives status under the qualification ruling
//     (lib/contact-promotion/qualification.ts) — a contact cannot be born
//     'qualified'.
// The OFFER-DRAFT half below (createOfferDraft, createInitialOfferVersion) is
// NOT adjudicated by this deletion — it is a separate capability and its
// reachability question is recorded in the wave notes, not resolved here.
// ─────────────────────────────────────────────────────────────────────────────


export interface CreateOfferDraftParams {
  agent_id: string
  contact_id?: string
  listing_id?: string
  property_address: string
  offer_price: number
  
  // Optional terms
  earnest_money?: number
  down_payment_percent?: number
  financing_type?: string
  contingencies?: string[]
  closing_date?: string
  possession_date?: string
  expiration_date?: string
  
  // Party information
  buyer_name?: string
  buyer_email?: string
  seller_name?: string
  seller_email?: string
  
  notes?: string
  user_role?: string
}

/**
 * Creates an offer draft
 * 
 * This function creates the initial offer data structure with all required
 * fields and validations. The caller is responsible for:
 * 1. Persisting the offer to the database
 * 2. Creating the initial OfferVersion record
 * 3. Any notifications or workflow triggers
 * 
 * @param params - Offer creation parameters
 * @returns Offer data ready to be persisted
 */
export function createOfferDraft(params: CreateOfferDraftParams): OfferCreationResult {
  const { agent_id, contact_id, user_role } = params

  // Permission check
  const permissionCheck = canCreateOffer({
    agent_id,
    contact: contact_id ? { id: contact_id, agent_id } as Contact : null,
    user_role,
  })

  if (!permissionCheck.allowed) {
    return {
      success: false,
      error: permissionCheck.reason,
    }
  }

  // Validation
  if (!params.property_address) {
    return {
      success: false,
      error: "Property address is required",
    }
  }

  if (!params.offer_price || params.offer_price <= 0) {
    return {
      success: false,
      error: "Valid offer price is required",
    }
  }

  // Build offer object
  const offer: Partial<Offer> = {
    // Agent/Contact
    agent_id,
    contact_id,

    // Property
    listing_id: params.listing_id,
    property_address: params.property_address,

    // Offer details
    offer_type: "purchase", // Default to purchase
    status: "draft",
    current_version: 1,

    // Parties
    buyer_name: params.buyer_name,
    buyer_email: params.buyer_email,
    seller_name: params.seller_name,
    seller_email: params.seller_email,

    // Terms
    offer_price: params.offer_price,
    earnest_money: params.earnest_money,
    down_payment_percent: params.down_payment_percent,
    financing_type: params.financing_type,
    contingencies: params.contingencies || [],
    closing_date: params.closing_date,
    possession_date: params.possession_date,

    // Expiration
    expiration_date: params.expiration_date,

    // Workflow state
    ready_for_signature: false,

    // Metadata
    notes: params.notes,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  return {
    success: true,
    offer: offer as Offer,
  }
}

/**
 * Creates the initial offer version (version 1) for a new offer
 *
 * @param offer - The offer to version
 * @returns The initial OfferVersion
 */
export function createInitialOfferVersion(offer: Offer): OfferVersion {
  return {
    id: "", // Will be set by database
    offer_id: offer.id,

    version_number: 1,
    version_type: "initial",
    created_by_party: "buyer", // Assuming buyer initiates

    offer_price: offer.offer_price,
    earnest_money: offer.earnest_money,
    down_payment_percent: offer.down_payment_percent,
    financing_type: offer.financing_type,
    contingencies: offer.contingencies,
    closing_date: offer.closing_date,
    possession_date: offer.possession_date,

    status: "active",

    notes: "Initial offer",
    created_at: new Date().toISOString(),
  }
}

// (sendOfferToDotloop / updateOfferAfterDotloopSync were retired: a caller-less
// formatter that returned success WITHOUT calling Dotloop. The live rail is
// createOfferDotloop (app/actions/ai-offer-creation) via the send_for_esign
// adapter. Keep-one, open-loop sweep.)
