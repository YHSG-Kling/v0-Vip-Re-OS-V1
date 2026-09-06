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

// TOMBSTONE (orphan doctrine §1.1, 2026-09-01): interface `Lead` and its
// LeadStatus / LeadSource / LeadIntent unions deleted — zero importers (the
// only names imported from this module are Contact / Offer / OfferStatus /
// OfferVersion / OfferCreationResult, verified repo-wide). SURVIVOR:
// app/types/lead-management.ts:11 `Lead` (imported by
// app/actions/lead-management.ts), onto which the real-column
// enrichment/conversion fields were merged first (lead_score, budget_min/max,
// timeline, property_type, updated_at, last_activity_at, converted_at,
// contact_id).
//
// VOCABULARY DECISION (§6 — recorded, deliberately NOT equalized): the two
// Lead shapes carried DIFFERENT unions and leads.status has NO live CHECK, so
// neither spelling is database-proven. This file said
//   status: new|contacted|qualified|nurturing|converted|disqualified|unresponsive
//   source: zillow|realtor_com|facebook|google|referral|website|cold_call|email_campaign|open_house|sphere|other
//   intent: buy|sell|invest|rent|research|unknown
// while the survivor says
//   status: new|enriched|qualified|converted|rejected
//   source: scraped|website_form|ghl|manual
//   intent: buying|selling|distress|investor.
// Merging the value sets here would have been the exact §6 bleed the timeline
// merge precedent warns about (a scorer matching writers across two
// spellings): pick one vocabulary against live row values + writers, in its
// own change, before any CHECK is added.

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
  /** LIVE column and the tenant predicate on every contacts read/write (§4).
   *  Was missing here while types/contact.ts:66 carried it — the opposite drift
   *  of the phantom fields removed below (a real column the type hid). */
  brokerage_id?: string | null
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

  // TOMBSTONE (§1, 2026-09-01): the inline `property_interest` object deleted —
  // PHANTOM: live contacts carries no such column (generated
  // scripts/schema-snapshot.ts:239 contacts column list). The capability is not
  // lost; the fact lives in two REAL places:
  //   · leads.property_interest (text — scripts/schema-snapshot.ts:369), read by
  //     the lead-side personalization (app/actions/ai-isa/initiate-engagement.ts:403);
  //     a contact reaches it through its lead lineage, leads.contact_id
  //     (stamped by lib/contact-promotion/history-carry.ts:241)
  //   · property_interests — the per-contact preferences child table
  //     (contact_id FK → contacts.id, scripts/schema-snapshot.ts:531) with
  //     typed columns (property_type, min/max_price, preferred_locations, …)
  //     instead of an untyped bag.
  // Same deletion made in types/contact.ts the same day.

  // Portal access
  contact_user_id?: string
  has_login: boolean
  login_created_at?: string

  // TOMBSTONE (§1, 2026-09-01): `is_referral_source`, `referred_by_contact_id`,
  // `referred_by_name`, `referral_notes` deleted — PHANTOMS minted by the
  // UNAPPLIED scripts/250-add-contact-agent-referral-tracking.sql (the same
  // script whose vendor_type/lender_* trio is tombstoned below); none exists on
  // live contacts (scripts/schema-snapshot.ts:239). SURVIVOR: the referrals
  // table (scripts/schema-snapshot.ts:552), which already stores each fact at
  // the correct grain (one row per referral, not a flag per contact):
  //   is_referral_source     → EXISTS referrals row with referrer_contact_id = contacts.id
  //   referred_by_contact_id → referrals.referrer_contact_id on the row whose
  //                            referred_contact_id is this contact
  //   referred_by_name       → referrals.source_contact_name / referrals.referred_by
  //   referral_notes         → referrals.notes
  // `referral_count` survives below as a DERIVED count of those rows — never a
  // stored aggregate (the writerless-gate guard exists to catch aggregates
  // nothing updates).

  // TOMBSTONE (§1, 2026-09-01): `vendor_type`, `lender_company`, `lender_nmls`
  // deleted — PHANTOM fields, absent from live contacts (generated
  // scripts/schema-snapshot.ts contacts column list). SURVIVORS: vendor_type →
  // vendors.category (aliased at app/actions/portal-seller.ts:828);
  // lender_company / lender_nmls → the lender-portal ledger tables
  // (app/actions/lender-portal-actions.ts:255/339/393). Same deletion made in
  // types/contact.ts the same day.

  // TOMBSTONE (§1/§6, 2026-09-01): `service_area?: string` deleted — a free-TEXT
  // service area is the third geographic vocabulary the measured grain ruling at
  // lib/vendors/vendor-service-area.ts:44-70 forbids (the repo's grain is
  // state + zip_code, matching subscriber_service_areas). SURVIVOR:
  // vendor_service_areas (scripts/schema-snapshot.ts:707), reached two-hop via
  // contacts.vendor_id (m595, WRITTEN NOT APPLIED) → vendors.platform_vendor_id —
  // the hop lib/vendors/vendor-service-area.ts + app/actions/vendor-service-areas.ts
  // already implement. The derived shape is `service_areas` below.
  /** DERIVED, never stored: contacts.vendor_id (m595, WRITTEN NOT APPLIED —
   *  integrator applies) → vendors.rating (per-tenant bench rating; rollups in
   *  vendor_ratings). Populated by getContact when the bridge row exists;
   *  null/absent otherwise. */
  rating?: number | null
  /** DERIVED, never stored: contacts.vendor_id → vendors.platform_vendor_id →
   *  vendor_service_areas rows (state + zip_code grain,
   *  lib/vendors/vendor-service-area.ts:44-70). */
  service_areas?: Array<{ state: string; zip_code: string | null; trade_category: string; status: string }>

  // History
  // TOMBSTONE (§1, 2026-09-01): `total_transactions`, `last_transaction_date`
  // deleted — PHANTOM stored aggregates from the unapplied script 250, absent
  // from live contacts (scripts/schema-snapshot.ts:239) and with no writer that
  // could ever have kept them true. SURVIVORS: the DERIVED `transaction_count` /
  // `last_closed_at` below, computed at read time from transactions rows —
  // three-sided grain (buyer_contact_id | seller_contact_id | contact_id) in
  // lib/contacts/transaction-rollup.ts, filled by
  // lib/services/contact-management.service.ts getContact.
  /** DERIVED, never stored — count of transactions rows naming this contact on
   *  ANY of the three contact FKs (lib/contacts/transaction-rollup.ts). */
  transaction_count?: number
  /** DERIVED, never stored — max close_date across this contact's CLOSED
   *  transactions (lib/contacts/transaction-rollup.ts), ISO string or null. */
  last_closed_at?: string | null
  /** DERIVED, never stored — count of referrals rows with
   *  referrer_contact_id = contacts.id (see referral tombstone above). */
  referral_count?: number
  /** LIVE column contacts.last_contacted_at (writer: markContactTouched,
   *  app/dashboard/stale/actions.ts:315; readers: the stale detector and its
   *  guard chain). This field was spelled `last_contacted` here — a name no
   *  live column has; the same spelling confusion once left a cron filtering on
   *  created_at "as fallback" while the column existed all along
   *  (lib/ai-isa/stale-contact-detector.ts:15-23). */
  last_contacted_at?: string | null
  notes?: string

  // Metadata
  created_at: string
  updated_at: string
  deleted_at?: string

  // TOMBSTONE (§1, 2026-09-01): `assigned_agent_id`, `assigned_agent_name`
  // deleted — PHANTOMS (unapplied script 250; absent from live contacts,
  // scripts/schema-snapshot.ts:239). SURVIVORS: the assignment column IS
  // contacts.agent_id (app/actions/seller-coaching.ts:49 records this exact
  // phantom having broken a query against listings); the display name is
  // JOIN-DERIVED where needed — the app/actions/ai-isa.ts:730 pattern
  // (`assigned_agent:users!… (first_name, last_name)` composed at read time) —
  // never stored on the row.

  // TOMBSTONE (§1, 2026-09-01): `promoted_from_lead_id`, `promoted_at` deleted —
  // PHANTOMS: live contacts carries neither (scripts/schema-snapshot.ts:239).
  // The lineage is stored in the INVERSE direction, on the lead:
  // leads.contact_id + leads.converted_at (scripts/schema-snapshot.ts:369),
  // stamped by lib/contact-promotion/history-carry.ts:241. Walk contact→lead by
  // querying leads where contact_id = contacts.id.
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

// TOMBSTONE (orphan doctrine §1.1, 2026-09-01): interface `LeadPromotionResult`
// deleted — zero importers, and the THIRD spelling of the promotion-result
// idea. SURVIVOR: lib/contact-promotion/promote-lead-to-contact.ts:15
// `PromotionResult` (re-exported via lib/contact-promotion/index.ts:13), the
// return type of the live promotion door promoteLeadToContactService — the
// same survivor the deleted promoteLeadToContact half of
// lib/lifecycle/offer-lifecycle.ts already points to. Nothing merged: the
// survivor carries success/message/contactId (+ best-effort warnings) and the
// real promotion history.

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
