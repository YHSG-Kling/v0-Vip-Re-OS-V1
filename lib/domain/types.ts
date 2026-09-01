/**
 * Canonical Domain Types
 * 
 * This module defines the core domain types for the application.
 * These types represent the canonical data model and should be used
 * across the application for consistency.
 */

import type { StandardTimeline } from "@/constants/crm-standards"
import type { ContactStatus as CanonicalContactStatus } from "@/lib/contact-promotion/qualification"
import type { ContactType as CanonicalContactType } from "@/lib/contact-types"

// ============================================
// LEAD
// ============================================

export type LeadStatus = 
  | "new"
  | "contacted"
  | "qualified"
  | "nurturing"
  | "converted"
  | "disqualified"
  | "unresponsive"

export type LeadSource = 
  | "zillow"
  | "realtor_com"
  | "facebook"
  | "google"
  | "referral"
  | "website"
  | "cold_call"
  | "email_campaign"
  | "open_house"
  | "sphere"
  | "other"

export type LeadIntent = 
  | "buy"
  | "sell"
  | "invest"
  | "rent"
  | "research"
  | "unknown"

/**
 * Lead represents an external prospect that has not yet been assigned
 * to an agent. Leads are typically enriched from external sources like
 * Zillow, Realtor.com, or lead generation platforms.
 */
export interface Lead {
  id: string
  
  // Identity
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  
  // Classification
  status: LeadStatus
  source: LeadSource
  intent: LeadIntent
  
  // Enrichment data
  lead_score?: number
  urgency_score?: number
  budget_min?: number
  budget_max?: number
  timeline?: string
  location?: string
  property_type?: string[]
  
  // Metadata
  enriched_data?: Record<string, any>
  external_id?: string
  created_at: string
  updated_at: string
  last_activity_at?: string
  
  // Assignment tracking
  assigned_to_agent_id?: string
  assigned_at?: string
  converted_to_contact_id?: string
  converted_at?: string
}

// ============================================
// CONTACT
// ============================================

/**
 * REPOINTED (§1/§6, 2026-09-01) onto the ONE contact_type vocabulary —
 * lib/contact-types.ts CONTACT_TYPES / ContactType, the roster the live
 * contacts_contact_type_check enforces (m593 APPLIED: lead, prospect,
 * lifetime_customer, sphere, vendor, referral_partner, buyer, seller, both,
 * other) — the same alias treatment ContactStatus / ContactTimeline in this
 * file already have, and the same repoint made to types/contact.ts the same
 * day. The eight-member union that stood here named FOUR values the database
 * refuses on write (23514, silently resolved — §3): lender, commercial, agent,
 * tc. Where each lives instead: lender → vendors.category='lender' /
 * users.user_type='lender'; commercial → contacts.property_type='commercial';
 * agent → contact_type='referral_partner' (internal agents are agents-table
 * rows); tc → users.user_type='tc' + contacts.tc_user_id.
 */
export type ContactType = CanonicalContactType

// REKEYED (§6, 2026-08-31) — this union used to spell the RETIRED 16-value
// persona set (first_time_buyer, motivated_seller, upsizers, remote_seller, …),
// none of which the live contacts_contact_persona_check admits: any write typed
// by it was a 23514 that rejected the whole row (§3). Its last literal producer
// was offer-lifecycle's dead promotion path, deleted the same day (see the
// tombstone there naming promoteLeadToContactService as the survivor). Now the
// thirteen values the CHECK admits, kept in lockstep with the canonical kernel
// Persona union and constants/crm-standards.ts — the CHECK is the authority.
export type ContactPersona =
  | "first_time"
  | "luxury"
  | "relocated"
  | "upsize"
  | "downsize"
  | "military"
  | "foreclosure"
  | "divorce"
  | "probate"
  | "senior"
  | "expired"
  | "fsbo"
  // Owner ruling 2026-08-31: "investor is a persona and not a contact type."
  // m589 (APPLIED) made it the fourteenth member of contacts_contact_persona_check.
  | "investor"
  | "other"

/**
 * REPOINTED (2026-08-31) to the one `contacts.status` vocabulary —
 * lib/contact-promotion/qualification.ts CONTACT_STATUSES, the list the m587
 * CHECK enforces. The eleven-member journey ladder that stood here
 * (appointment_booked … lifetime_customer) described DEAL/JOURNEY facts that
 * live on buyer_stage, listings.status, transactions and contact_type — no
 * writer ever stored any of them on contacts.status. Same repoint as
 * ContactTimeline below: an alias of a single exported list, never a copy.
 */
export type ContactStatus = CanonicalContactStatus

/**
 * REPOINTED to the one timeline vocabulary — constants/crm-standards.ts:STANDARD_TIMELINES.
 *
 * This was the second of two identical hand-maintained copies of a list that had
 * six spellings across the tree (the other was types/contact.ts). Both are now
 * aliases of the single exported list, which is also what the live CHECK on
 * leads.timeline / contacts.timeline / lead_intelligence.timeline /
 * unified_lead_profile.estimated_timeline admits (m487).
 */
export type ContactTimeline = StandardTimeline

/**
 * Contact represents a prospect that has been assigned to an agent
 * and is actively being worked. Contacts are created either from
 * direct input or by converting/promoting a Lead.
 */
export interface Contact {
  id: string
  
  // Identity
  agent_id: string
  first_name: string
  last_name: string
  email: string
  phone?: string
  
  // Classification
  contact_type: ContactType
  contact_persona: ContactPersona
  status: ContactStatus
  timeline: ContactTimeline
  source: string
  
  // Property interest
  property_interest?: {
    // Buyer fields
    budget_min?: number
    budget_max?: number
    desired_neighborhoods?: string[]
    move_in_timeline?: string
    property_type_preference?: string[]
    
    // Seller fields
    current_home_value?: number
    timeline_to_sell?: string
    reason_for_selling?: string
    property_condition?: string
    
    // Investor fields
    investment_type?: string
    target_roi?: number
    experience_level?: string
    
    [key: string]: any
  }
  
  // Portal access
  contact_user_id?: string
  has_login: boolean
  login_created_at?: string
  
  // Referral tracking
  is_referral_source?: boolean
  referred_by_contact_id?: string
  referred_by_name?: string
  referral_count?: number
  referral_notes?: string
  
  // TOMBSTONE (§1, 2026-09-01): `vendor_type`, `lender_company`, `lender_nmls`
  // deleted — PHANTOM fields, absent from live contacts (generated
  // scripts/schema-snapshot.ts contacts column list). SURVIVORS: vendor_type →
  // vendors.category (aliased at app/actions/portal-seller.ts:828);
  // lender_company / lender_nmls → the lender-portal ledger tables
  // (app/actions/lender-portal-actions.ts:255/339/393). Same deletion made in
  // types/contact.ts the same day.
  service_area?: string
  rating?: number
  
  // History
  total_transactions?: number
  last_transaction_date?: string
  last_contacted?: string
  notes?: string
  
  // Metadata
  created_at: string
  updated_at: string
  deleted_at?: string
  
  // Assignment
  assigned_agent_id?: string
  assigned_agent_name?: string
  
  // Lead conversion tracking
  promoted_from_lead_id?: string
  promoted_at?: string
}

// ============================================
// LISTING
// ============================================

export type ListingStatus =
  | "coming_soon"
  | "active"
  | "pending"
  | "under_contract"
  | "sold"
  | "withdrawn"
  | "expired"
  | "canceled"

export type PropertyType =
  | "single_family"
  | "condo"
  | "townhouse"
  | "multi_family"
  | "land"
  | "commercial"
  | "other"

/**
 * Listing represents a property that is or was available for sale/lease.
 * Listings can be agent's own listings or external listings they're working with.
 */
export interface Listing {
  id: string
  
  // Agent/Brokerage
  agent_id: string
  brokerage_id?: string
  
  // Property details
  mls_number?: string
  address: string
  city?: string
  state?: string
  zip_code?: string
  
  property_type: PropertyType
  bedrooms?: number
  bathrooms?: number
  square_feet?: number
  lot_size?: number
  year_built?: number
  
  // Listing details
  status: ListingStatus
  list_price: number
  original_list_price?: number
  sale_price?: number
  
  // Dates
  list_date?: string
  pending_date?: string
  sold_date?: string
  expiration_date?: string
  
  // Marketing
  description?: string
  photos?: string[]
  virtual_tour_url?: string
  showing_instructions?: string
  
  // Features
  features?: string[]
  amenities?: string[]
  
  // Lockbox/access
  lockbox_code?: string
  alarm_code?: string
  
  // Metadata
  created_at: string
  updated_at: string
  deleted_at?: string
  
  // External sync
  external_source?: string
  external_id?: string
  last_synced_at?: string
}

// ============================================
// OFFER
// ============================================

export type OfferStatus =
  | "draft"
  | "pending_review"
  | "ready_to_send"
  | "sent_for_signature"
  | "partially_signed"
  | "fully_signed"
  | "accepted"
  | "countered"
  | "rejected"
  | "expired"
  | "withdrawn"

export type OfferType =
  | "purchase"
  | "lease"
  | "counter"

export type OfferParty =
  | "buyer"
  | "seller"
  | "landlord"
  | "tenant"

/**
 * Offer represents a purchase/lease offer. Offers exist independently
 * before becoming part of a transaction. They track versions for
 * counter-offers and negotiation history.
 */
export interface Offer {
  id: string
  
  // Agent/Contact
  agent_id: string
  contact_id?: string // The client making the offer
  
  // Property
  listing_id?: string
  property_address: string
  
  // Offer details
  offer_type: OfferType
  status: OfferStatus
  current_version: number
  
  // Parties
  buyer_name?: string
  buyer_email?: string
  seller_name?: string
  seller_email?: string
  
  // Key terms (current version)
  offer_price: number
  earnest_money?: number
  down_payment_percent?: number
  financing_type?: string
  contingencies?: string[]
  closing_date?: string
  possession_date?: string
  
  // Expiration
  expiration_date?: string
  
  // Integration
  dotloop_loop_id?: string
  dotloop_status?: string
  last_synced_with_dotloop?: string
  
  // Workflow state
  ready_for_signature: boolean
  sent_for_signature_at?: string
  fully_signed_at?: string
  accepted_at?: string
  
  // Transaction linkage
  transaction_id?: string // Set when offer converts to transaction
  converted_to_transaction_at?: string
  
  // Metadata
  notes?: string
  created_at: string
  updated_at: string
  created_by_user_id?: string
}

// ============================================
// OFFER VERSION
// ============================================

export type OfferVersionType =
  | "initial"
  | "counter_by_buyer"
  | "counter_by_seller"
  | "revision"

/**
 * OfferVersion represents a specific version of an offer, tracking
 * the negotiation history through counters and revisions.
 */
export interface OfferVersion {
  id: string
  offer_id: string
  
  // Version tracking
  version_number: number
  version_type: OfferVersionType
  created_by_party: OfferParty
  
  // Terms for this version
  offer_price: number
  earnest_money?: number
  down_payment_percent?: number
  financing_type?: string
  contingencies?: string[]
  closing_date?: string
  possession_date?: string
  
  // Special terms
  terms?: Record<string, any>
  
  // Status
  status: "active" | "superseded" | "accepted" | "rejected"
  
  // Response tracking
  responded_at?: string
  response_notes?: string
  
  // Metadata
  notes?: string
  created_at: string
  created_by_user_id?: string
}

// ============================================
// HELPER TYPES
// ============================================

/**
 * Represents the result of a lead-to-contact promotion
 */
export interface LeadPromotionResult {
  success: boolean
  contact_id?: string
  contact?: Contact
  error?: string
}

/**
 * Represents the result of creating an offer draft
 */
export interface OfferCreationResult {
  success: boolean
  offer_id?: string
  offer?: Offer
  error?: string
}

// TOMBSTONE (§1.3, 2026-08-31, lane M4): interface `DotloopSyncResult` deleted.
// Scaffolding-era return type for "send an offer to Dotloop" that the live
// integration never adopted: the real sender is app/actions/ai-offer-creation.ts
// (per-brokerage credential via the dotloop connector, returning its own inline
// { success, loopUrl, ... } shape), document sync is app/actions/
// dotloop-integration.ts, and transactions carry the generic
// external_provider_source / external_provider_transaction_id columns (m106,
// lib/transactions/offer-bridge.ts) rather than dotloop_status. No importer
// anywhere; no capability lost.
