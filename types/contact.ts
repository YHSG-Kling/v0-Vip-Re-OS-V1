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
  // TOMBSTONE (§1, 2026-09-01): `property_interest?: PropertyInterest` and the
  // PropertyInterest interface deleted — PHANTOM: live contacts carries no such
  // column (scripts/schema-snapshot.ts:239). SURVIVORS: leads.property_interest
  // (text, scripts/schema-snapshot.ts:369 — reached from a contact through its
  // lead lineage, leads.contact_id, stamped by
  // lib/contact-promotion/history-carry.ts:241) and the property_interests
  // child table (contact_id FK → contacts.id, scripts/schema-snapshot.ts:531)
  // with typed preference columns. Same deletion in lib/domain/types.ts.
  created_at: string
  updated_at: string
  /** LIVE column contacts.last_contacted_at (writer: markContactTouched,
   *  app/dashboard/stale/actions.ts:315, guard-enforced; readers include the
   *  stale detector). Was spelled `last_contacted` — a name no live column has;
   *  that exact confusion once left a cron filtering on created_at "as
   *  fallback" while the real column existed all along
   *  (lib/ai-isa/stale-contact-detector.ts:15-23). */
  last_contacted_at?: string | null
  contact_user_id?: string
  has_login: boolean
  login_created_at?: string
  deleted_at?: string
  // TOMBSTONE (§1, 2026-09-01): `assigned_agent_id`, `assigned_agent_name`
  // deleted — PHANTOMS (unapplied scripts/250-add-contact-agent-referral-tracking.sql;
  // absent from live contacts, scripts/schema-snapshot.ts:239). SURVIVORS:
  // contacts.agent_id IS the assignment column (app/actions/seller-coaching.ts:49
  // records this exact phantom breaking a query); the display name is
  // JOIN-DERIVED at read time — the app/actions/ai-isa.ts:730 pattern — never
  // stored. Same deletion in lib/domain/types.ts.
  // TOMBSTONE (§1, 2026-09-01): `is_referral_source`, `referred_by_contact_id`,
  // `referred_by_name`, `referral_notes` deleted — PHANTOMS minted by the same
  // unapplied script 250; none exists on live contacts
  // (scripts/schema-snapshot.ts:239). SURVIVOR: the referrals table
  // (scripts/schema-snapshot.ts:552) at the correct grain —
  //   is_referral_source     → EXISTS referrals row, referrer_contact_id = contacts.id
  //   referred_by_contact_id → referrals.referrer_contact_id (row whose
  //                            referred_contact_id is this contact)
  //   referred_by_name       → referrals.source_contact_name / referrals.referred_by
  //   referral_notes         → referrals.notes
  // `referral_count` survives below as a DERIVED count of those rows.
  /** DERIVED, never stored — count of referrals rows with
   *  referrer_contact_id = contacts.id (the writerless-gate guard exists to
   *  catch stored aggregates nothing updates). */
  referral_count?: number
  // TOMBSTONE (§1, 2026-09-01): `vendor_type`, `lender_company`, `lender_nmls`
  // deleted — PHANTOM fields: none exists on live contacts (verified against the
  // generated scripts/schema-snapshot.ts contacts column list; a reader of a
  // phantom field renders nothing, a writer is refused wholesale — PGRST204, §3).
  // SURVIVORS: vendor_type → vendors.category (the portal surfaces already alias
  // it: app/actions/portal-seller.ts:828 `vendor_type:category`);
  // lender_company / lender_nmls → live columns on the lender-portal ledger
  // tables, written at app/actions/lender-portal-actions.ts:255/339/393 — never
  // columns of contacts.
  // TOMBSTONE (§1/§6, 2026-09-01): `service_area?: string` deleted — a free-TEXT
  // service area is the third geographic vocabulary the measured ruling at
  // lib/vendors/vendor-service-area.ts:44-70 forbids (grain is state + zip_code,
  // matching subscriber_service_areas). SURVIVOR: vendor_service_areas
  // (scripts/schema-snapshot.ts:707) via contacts.vendor_id (m595, WRITTEN NOT
  // APPLIED) → vendors.platform_vendor_id — the two-hop
  // lib/vendors/vendor-service-area.ts + app/actions/vendor-service-areas.ts
  // already implement. The derived shape is `service_areas` below.
  /** DERIVED, never stored: contacts.vendor_id (m595, WRITTEN NOT APPLIED —
   *  integrator applies) → vendors.rating (rollups in vendor_ratings). */
  rating?: number | null
  /** DERIVED, never stored: contacts.vendor_id → vendors.platform_vendor_id →
   *  vendor_service_areas rows (state + zip_code grain). */
  service_areas?: Array<{ state: string; zip_code: string | null; trade_category: string; status: string }>
  // TOMBSTONE (§1, 2026-09-01): `total_transactions`, `last_transaction_date`
  // deleted — PHANTOM stored aggregates from the unapplied script 250, absent
  // from live contacts (scripts/schema-snapshot.ts:239), with no writer to keep
  // them true. SURVIVORS: the DERIVED `transaction_count` / `last_closed_at`
  // below — computed from transactions rows at read time, three-sided grain in
  // lib/contacts/transaction-rollup.ts, filled by
  // lib/services/contact-management.service.ts getContact.
  /** DERIVED, never stored — count of transactions rows naming this contact on
   *  ANY of buyer_contact_id / seller_contact_id / contact_id
   *  (lib/contacts/transaction-rollup.ts). */
  transaction_count?: number
  /** DERIVED, never stored — max close_date across this contact's CLOSED
   *  transactions (lib/contacts/transaction-rollup.ts). */
  last_closed_at?: string | null
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
