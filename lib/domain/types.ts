/**
 * Canonical Domain Types
 * 
 * This module defines the core domain types for the application.
 * These types represent the canonical data model and should be used
 * across the application for consistency.
 */

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

export type ContactType =
  | "buyer"
  | "seller"
  | "investor"
  | "lender"
  | "commercial"
  | "agent"
  | "vendor"
  | "tc"
  | "other"

export type ContactPersona =
  | "first_time_buyer"
  | "luxury_buyer"
  | "luxury_seller"
  | "investor"
  | "first_time_seller"
  | "motivated_seller"
  | "relocating"
  | "empty_nester"
  | "probate"
  | "remote_seller"
  | "divorce"
  | "upsizers"
  | "senior"
  | "expired"
  | "fsbo"
  | "other"

export type ContactStatus =
  | "new"
  | "contacted"
  | "qualified"
  | "appointment_booked"
  | "signed_agreement"
  | "pre_listing"
  | "active_listing"
  | "contingent"
  | "pending"
  | "sold"
  | "lifetime_customer"

export type ContactTimeline = 
  | "0-3_months"
  | "3-6_months"
  | "6-12_months"
  | "12+_months"

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
  
  // Professional contacts (lender, vendor, etc.)
  vendor_type?: string
  lender_company?: string
  lender_nmls?: string
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

/**
 * Represents the result of sending an offer to Dotloop
 */
export interface DotloopSyncResult {
  success: boolean
  dotloop_loop_id?: string
  dotloop_status?: string
  error?: string
}
