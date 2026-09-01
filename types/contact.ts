import type { StandardTimeline, StandardContactPersona } from "@/constants/crm-standards"
import type { ContactStatus as CanonicalContactStatus } from "@/lib/contact-promotion/qualification"
import type { ContactType as CanonicalContactType } from "@/lib/contact-types"

/**
 * REPOINTED (§1/§6, 2026-09-01) onto the ONE contact_type vocabulary —
 * lib/contact-types.ts CONTACT_TYPES / ContactType, the roster the live
 * contacts_contact_type_check enforces (m593, APPLIED: lead, prospect,
 * lifetime_customer, sphere, vendor, referral_partner, buyer, seller, both,
 * other) — the same alias treatment ContactPersona / ContactStatus /
 * ContactTimeline below already have.
 *
 * The eight-member union that stood here (buyer | seller | lender | commercial |
 * other | agent | vendor | TC) named FOUR values the database REFUSES on write
 * (23514, silently resolved by supabase-js — §3): lender, commercial, agent, TC.
 * A Contact typed with it could never round-trip. Where each refused concept
 * actually lives:
 *   lender     → vendors.category='lender' / users.user_type='lender' /
 *                referral_partners.partner_type='mortgage_broker'
 *   commercial → contacts.property_type='commercial' (a property attribute,
 *                not a transaction side)
 *   agent      → contacts.contact_type='referral_partner' as a contact;
 *                internal agents are agents-table rows
 *   TC         → users.user_type='tc' (m036) + contacts.tc_user_id
 */
export type ContactType = CanonicalContactType

// REPOINTED (§6, 2026-08-31) onto the ONE persona vocabulary — constants/crm-standards.ts
// STANDARD_CONTACT_PERSONAS, rekeyed there onto the live contacts_contact_persona_check
// (14 values since m589: first_time, luxury, relocated, upsize, downsize, military,
// foreclosure, divorce, probate, senior, expired, fsbo, investor, other — the same set as
// the kernel `Persona` union and lib/campaigns/contact-sources.ts CAMPAIGN_PERSONAS,
// 'investor' by the owner ruling "investor is a persona and not a contact type").
// The 16-member union that
// stood here (first_time_buyer, luxury_buyer, motivated_seller, empty_nester, remote_seller,
// upsizers, …) named values the live CHECK refuses, so a Contact typed with it could never
// round-trip through the database.
export type ContactPersona = StandardContactPersona

/**
 * REPOINTED (2026-08-31) to the one `contacts.status` vocabulary —
 * lib/contact-promotion/qualification.ts CONTACT_STATUSES, the list the m587
 * CHECK enforces — exactly as ContactTimeline below is an alias of
 * STANDARD_TIMELINES rather than a copy. The eleven-member journey ladder that
 * stood here (appointment_booked … lifetime_customer) named DEAL/JOURNEY facts
 * carried by buyer_stage, listings.status, transactions and contact_type; no
 * writer ever stored any of them on contacts.status.
 */
export type ContactStatus = CanonicalContactStatus

/**
 * REPOINTED to the one timeline vocabulary — constants/crm-standards.ts:STANDARD_TIMELINES.
 *
 * This used to declare its own list (`0-3_months | 3-6_months | 6-12_months |
 * 12+_months`), one of six spellings of the same concept. It is an ALIAS now
 * rather than a copy so a member can only ever be added or removed in one place;
 * the live CHECK on contacts.timeline (m487) is generated from the same list.
 */
export type ContactTimeline = StandardTimeline

export type ContactSource = "website" | "referral" | "cold_call" | "social" | "other" | "zillow" | "realtor.com"

export interface Contact {
  id: string
  agent_id: string
  brokerage_id?: string | null
  first_name: string
  last_name: string
  email: string
  phone?: string
  contact_type: ContactType
  contact_persona: ContactPersona
  status: ContactStatus
  timeline: ContactTimeline
  source: ContactSource
  notes?: string
  property_interest?: PropertyInterest
  created_at: string
  updated_at: string
  last_contacted?: string
  contact_user_id?: string
  has_login: boolean
  login_created_at?: string
  deleted_at?: string
  assigned_agent_id?: string
  assigned_agent_name?: string
  is_referral_source?: boolean
  referred_by_contact_id?: string
  referred_by_name?: string
  referral_count?: number
  referral_notes?: string
  // TOMBSTONE (§1, 2026-09-01): `vendor_type`, `lender_company`, `lender_nmls`
  // deleted — PHANTOM fields: none exists on live contacts (verified against the
  // generated scripts/schema-snapshot.ts contacts column list; a reader of a
  // phantom field renders nothing, a writer is refused wholesale — PGRST204, §3).
  // SURVIVORS: vendor_type → vendors.category (the portal surfaces already alias
  // it: app/actions/portal-seller.ts:828 `vendor_type:category`);
  // lender_company / lender_nmls → live columns on the lender-portal ledger
  // tables, written at app/actions/lender-portal-actions.ts:255/339/393 — never
  // columns of contacts.
  service_area?: string
  rating?: number
  total_transactions?: number
  last_transaction_date?: string
}

export interface PropertyInterest {
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

  // Lender fields
  company?: string
  loan_programs?: string[]
  contact_info?: string

  // Other custom fields
  [key: string]: any
}

// ── TOMBSTONE · ContactFormData ─────────────────────────────────────────────
// DELETED in wave 14. Its only importers were app/api/contacts/create/route.ts
// and app/api/contacts/update/route.ts, both retired this same wave onto the
// server actions that already owned contact writes. Those survivors declare
// their own parameter shapes inline and never referenced this interface:
//
//   create → app/actions/contacts.ts:209  createContact
//   update → app/actions/contacts.ts:307  updateContact
//
// The capability is not lost — contact form typing lives on the survivors. What
// is gone is a second, drifting declaration of the same idea, which is the one
// vocabulary per function rule. It was still re-exported from the types barrel,
// so it LOOKED wired: a barrel re-export is a forwarding address, not a reader.

export interface ContactFilters {
  contact_type?: ContactType[]
  contact_persona?: ContactPersona[]
  timeline?: ContactTimeline[]
  status?: ContactStatus[]
  source?: ContactSource[]
  has_login?: boolean
  search?: string
}

export interface ContactAnalytics {
  by_type: Record<ContactType, number>
  by_persona: Record<ContactPersona, number>
  by_status: Record<ContactStatus, number>
  by_timeline: Record<ContactTimeline, number>
  total: number
  with_login: number
  conversion_rate: number
}
