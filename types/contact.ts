import type { StandardTimeline } from "@/constants/crm-standards"

export type ContactType =
  | "buyer"
  | "seller"
  | "investor"
  | "lender"
  | "commercial"
  | "other"
  | "agent"
  | "vendor"
  | "TC"

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
  vendor_type?: string
  lender_company?: string
  lender_nmls?: string
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

export interface ContactFormData {
  first_name: string
  last_name: string
  email: string
  phone?: string
  contact_type: ContactType
  contact_persona: ContactPersona
  timeline: ContactTimeline
  source: ContactSource
  status?: ContactStatus
  notes?: string
  property_interest?: PropertyInterest
}

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
