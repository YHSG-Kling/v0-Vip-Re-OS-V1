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
  Lead,
  Contact,
  Offer,
  OfferVersion,
  LeadPromotionResult,
  OfferCreationResult,
  ContactType,
  ContactPersona,
  ContactStatus,
  ContactTimeline,
} from "../domain/types"
import { STANDARD_TIMELINES } from "@/constants/crm-standards"
import { canCreateOffer } from "../permissions/offer-permissions"

// ============================================
// LEAD TO CONTACT PROMOTION
// ============================================

export interface PromoteLeadToContactParams {
  lead: Lead
  agent_id: string
  
  // Optional overrides
  contact_type?: ContactType
  contact_persona?: ContactPersona
  timeline?: ContactTimeline
  additional_notes?: string
}

/**
 * Promotes a Lead to a Contact
 * 
 * This function transforms lead data into contact data format and applies
 * business rules for the promotion. The caller is responsible for:
 * 1. Persisting the new contact to the database
 * 2. Updating the lead record with converted_to_contact_id
 * 3. Any notifications or side effects
 * 
 * @param params - Promotion parameters
 * @returns Contact data ready to be persisted
 */
export function promoteLeadToContact(params: PromoteLeadToContactParams): LeadPromotionResult {
  const { lead, agent_id, contact_type, contact_persona, timeline, additional_notes } = params

  // Validation
  if (!lead.id) {
    return {
      success: false,
      error: "Lead ID is required",
    }
  }

  if (!agent_id) {
    return {
      success: false,
      error: "Agent ID is required for contact assignment",
    }
  }

  if (lead.converted_to_contact_id) {
    return {
      success: false,
      error: "Lead has already been converted to a contact",
    }
  }

  if (lead.status === "disqualified") {
    return {
      success: false,
      error: "Cannot promote disqualified lead",
    }
  }

  // Derive contact type from lead intent
  const derivedContactType: ContactType = contact_type || deriveContactTypeFromIntent(lead.intent)

  // Derive contact persona from lead data
  const derivedPersona: ContactPersona = contact_persona || deriveContactPersona(lead)

  // Derive timeline
  const derivedTimeline: ContactTimeline = timeline || deriveTimelineFromLead(lead)

  // Derive initial status based on lead status
  const contactStatus: ContactStatus = deriveContactStatus(lead.status)

  // Build contact object
  const contact: Partial<Contact> = {
    // Identity
    agent_id,
    first_name: lead.first_name || "Unknown",
    last_name: lead.last_name || "Lead",
    email: lead.email || "",
    phone: lead.phone,

    // Classification
    contact_type: derivedContactType,
    contact_persona: derivedPersona,
    status: contactStatus,
    timeline: derivedTimeline,
    source: mapLeadSourceToContactSource(lead.source),

    // Property interest from lead enrichment
    property_interest: {
      budget_min: lead.budget_min,
      budget_max: lead.budget_max,
      property_type_preference: lead.property_type,
      move_in_timeline: lead.timeline,
      // Preserve any enriched data
      ...lead.enriched_data,
    },

    // Portal access
    has_login: false,

    // Notes
    notes: buildPromotionNotes(lead, additional_notes),

    // Lead tracking
    promoted_from_lead_id: lead.id,
    promoted_at: new Date().toISOString(),

    // Timestamps
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  return {
    success: true,
    contact: contact as Contact,
  }
}

/**
 * Helper: Derive contact type from lead intent
 */
function deriveContactTypeFromIntent(intent: string): ContactType {
  switch (intent) {
    case "buy":
      return "buyer"
    case "sell":
      return "seller"
    case "invest":
      return "investor"
    default:
      return "other"
  }
}

/**
 * Helper: Derive contact persona from lead data
 */
function deriveContactPersona(lead: Lead): ContactPersona {
  // Use lead score and data to infer persona
  if (lead.budget_max && lead.budget_max > 1000000) {
    return "luxury_buyer"
  }
  
  if (lead.intent === "invest") {
    return "investor"
  }

  if (lead.intent === "buy") {
    return "first_time_buyer" // Default assumption
  }

  if (lead.intent === "sell") {
    return "first_time_seller" // Default assumption
  }

  return "other"
}

/**
 * Helper: Derive timeline from lead
 *
 * REPOINTED to the one timeline vocabulary (constants/crm-standards.ts:
 * STANDARD_TIMELINES). This function used to TRANSLATE: it read `leads.timeline`
 * and emitted a DIFFERENT vocabulary (`0-3_months | 3-6_months | 6-12_months |
 * 12+_months`) onto `contacts.timeline`, which is how the two columns came to
 * disagree in the first place. Both columns now carry the same vocabulary and
 * the same live CHECK (m487), so there is nothing left to translate — a value
 * that is already a member is carried across UNCHANGED.
 *
 * The substring fallback is kept for the legacy free text that predates the
 * CHECK (`"3 months"`, `"asap"`, `"next year"`), but it is now the fallback and
 * not the main path, and it emits survivor members. The old chain had an
 * ordering bug worth naming, because it is the same shape of mistake: it tested
 * `includes("3") || includes("6")` BEFORE `includes("12")`, so ANY string
 * containing a 3 or a 6 — `"6-12 months"` included — landed on `3-6_months`.
 * The fallback below therefore matches RANGES before bare numbers, and reads
 * digits off a separator-normalised copy so `"3-6 months"`, `"3_6_months"` and
 * `"3 to 6 months"` all resolve the same way.
 */
function deriveTimelineFromLead(lead: Lead): ContactTimeline {
  if (lead.timeline) {
    // Already canonical → carry it across verbatim. No translation.
    if ((STANDARD_TIMELINES as readonly string[]).includes(lead.timeline)) {
      return lead.timeline as ContactTimeline
    }

    // Legacy free text. Separators collapsed so a range reads the same however
    // it was punctuated.
    const t = lead.timeline.toLowerCase()
    const n = t.replace(/[^a-z0-9]+/g, " ")

    if (/\b(asap|immediate|immediately|right away|now)\b/.test(n)) return "immediate"

    // RANGES FIRST — the upper bound of a range names the bucket.
    if (/\b6\b.*\b12\b/.test(n)) return "6-12_months"
    if (/\b3\b.*\b6\b/.test(n)) return "3-6_months"
    if (/\b(0|1)\b.*\b3\b/.test(n)) return "1-3_months"

    // Day-denominated legacy values — the 30/60/90 spelling that reached rows
    // only through scripts/351-create-demo-contacts-simple.sql. All three sit
    // inside the same bucket under the surviving boundaries.
    if (/\b(7|14|30|45|60|90)\b\s*days?\b/.test(n)) return "1-3_months"

    // Then single horizons, longest first.
    if (/\b12\b|\byear\b|\byears\b/.test(n)) return "12+_months"
    if (/\b(7|8|9|10|11)\b/.test(n)) return "6-12_months"
    if (/\b(4|5|6)\b/.test(n)) return "3-6_months"
    if (/\b(1|2|3)\b/.test(n)) return "1-3_months"
  }

  // Default based on urgency
  if (lead.urgency_score && lead.urgency_score > 75) {
    return "immediate"
  }

  return "3-6_months"
}

/**
 * Helper: Derive contact status from lead status
 */
function deriveContactStatus(leadStatus: string): ContactStatus {
  switch (leadStatus) {
    case "new":
      return "new"
    case "contacted":
      return "contacted"
    case "qualified":
      return "qualified"
    case "nurturing":
      return "contacted"
    default:
      return "new"
  }
}

/**
 * Helper: Map lead source to contact source
 */
function mapLeadSourceToContactSource(leadSource: string): string {
  // Direct mapping for most cases
  const sourceMap: Record<string, string> = {
    zillow: "zillow",
    realtor_com: "realtor.com",
    facebook: "social",
    google: "website",
    referral: "referral",
    website: "website",
    cold_call: "cold_call",
    sphere: "referral",
  }

  return sourceMap[leadSource] || "other"
}

/**
 * Helper: Build promotion notes
 */
function buildPromotionNotes(lead: Lead, additionalNotes?: string): string {
  const notes: string[] = []

  notes.push(`Promoted from lead (ID: ${lead.id})`)
  notes.push(`Original source: ${lead.source}`)
  
  if (lead.lead_score) {
    notes.push(`Lead score: ${lead.lead_score}`)
  }

  if (lead.external_id) {
    notes.push(`External ID: ${lead.external_id}`)
  }

  if (additionalNotes) {
    notes.push(additionalNotes)
  }

  return notes.join("\n")
}

// ============================================
// OFFER CREATION
// ============================================

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
