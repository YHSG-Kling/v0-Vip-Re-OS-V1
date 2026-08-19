// Standard CRM field values - THE source of truth for all CRM data
// These values are used across the entire application for workflows, automations, and data normalization

export const STANDARD_CRM_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "appointment_booked",
  "signed_agreement",
  "pre_listing",
  "active_listing",
  "contingent",
  "pending",
  "sold",
  "lifetime_customer",
] as const

export type StandardCRMStatus = (typeof STANDARD_CRM_STATUSES)[number]

export const STANDARD_CONTACT_PERSONAS = [
  "first_time_buyer",
  "luxury_buyer",
  "luxury_seller",
  "investor",
  "first_time_seller",
  "motivated_seller",
  "relocating",
  "empty_nester",
  "probate",
  "remote_seller",
  "divorce",
  "upsizers",
  "senior",
  "expired",
  "fsbo",
  "other",
] as const

export type StandardContactPersona = (typeof STANDARD_CONTACT_PERSONAS)[number]

export const STANDARD_CONTACT_TYPES = [
  "buyer",
  "seller",
  "investor",
  "lender",
  "commercial",
  "other",
  "agent",
  "vendor",
  "TC",
] as const

export type StandardContactType = (typeof STANDARD_CONTACT_TYPES)[number]

export const STANDARD_TIMELINES = [
  "immediate",
  "30_days",
  "60_days",
  "90_days",
  "6_months",
  "12_months",
  "12_plus_months",
] as const

export type StandardTimeline = (typeof STANDARD_TIMELINES)[number]

export const STANDARD_SOURCES = [
  "website",
  "referral",
  "sphere",
  "open_house",
  "cold_call",
  "door_knock",
  "social_media",
  "zillow_premier",
  "realtor_com_premier",
  "paid_ad",
  "past_client",
  "other",
] as const

export type StandardSource = (typeof STANDARD_SOURCES)[number]

// Human-readable labels for display
export const STATUS_LABELS: Record<StandardCRMStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  appointment_booked: "Appointment Booked",
  signed_agreement: "Signed Agreement",
  pre_listing: "Pre-Listing",
  active_listing: "Active Listing",
  contingent: "Contingent",
  pending: "Pending",
  sold: "Sold",
  lifetime_customer: "Lifetime Customer",
}

export const PERSONA_LABELS: Record<StandardContactPersona, string> = {
  first_time_buyer: "First Time Buyer",
  luxury_buyer: "Luxury Buyer",
  luxury_seller: "Luxury Seller",
  investor: "Investor",
  first_time_seller: "First Time Seller",
  motivated_seller: "Motivated Seller",
  relocating: "Relocating",
  empty_nester: "Empty Nester",
  probate: "Probate",
  remote_seller: "Remote Seller",
  divorce: "Divorce",
  upsizers: "Upsizer",
  senior: "Senior",
  expired: "Expired Listing",
  fsbo: "FSBO",
  other: "Other",
}

export const CONTACT_TYPE_LABELS: Record<StandardContactType, string> = {
  buyer: "Buyer",
  seller: "Seller",
  investor: "Investor",
  lender: "Lender",
  commercial: "Commercial",
  other: "Other",
  agent: "Agent",
  vendor: "Vendor",
  TC: "Transaction Coordinator",
}

export const TIMELINE_LABELS: Record<StandardTimeline, string> = {
  immediate: "Immediate",
  "30_days": "30 Days",
  "60_days": "60 Days",
  "90_days": "90 Days",
  "6_months": "6 Months",
  "12_months": "12 Months",
  "12_plus_months": "12+ Months",
}

export const SOURCE_LABELS: Record<StandardSource, string> = {
  website: "Website",
  referral: "Referral",
  sphere: "Sphere of Influence",
  open_house: "Open House",
  cold_call: "Cold Call",
  door_knock: "Door Knock",
  social_media: "Social Media",
  zillow_premier: "Zillow Premier",
  realtor_com_premier: "Realtor.com Premier",
  paid_ad: "Paid Ad",
  past_client: "Past Client",
  other: "Other",
}

export const PERSONA_DESCRIPTIONS: Record<StandardContactPersona, string> = {
  first_time_buyer: "Never owned before, needs education and guidance",
  luxury_buyer: "High-end purchase, expects premium service",
  luxury_seller: "High-end property sale, sophisticated needs",
  investor: "Investment focused, ROI driven",
  first_time_seller: "First time selling, needs process guidance",
  motivated_seller: "Needs to sell quickly, time-sensitive",
  relocating: "Moving for job/life change, dual market needs",
  empty_nester: "Downsizing after children leave",
  probate: "Inherited property, legal complexities",
  remote_seller: "Selling from distance, remote management",
  divorce: "Divorce-related sale, sensitive situation",
  upsizers: "Buying larger property, growing family",
  senior: "Senior citizen with age-specific needs",
  expired: "Previous listing expired, needs new strategy",
  fsbo: "For Sale By Owner, considering agent representation",
  other: "Other type of contact",
}

// `lib/contact-utils.ts` — WHOLE FILE DELETED (orphan burn-down, category C).
//
// It was a second, older copy of this file. It had ZERO importers anywhere in
// the tree — `grep -rn "contact-utils" --include=*.ts --include=*.tsx` matched
// nothing outside its own body; the only mentions left were tsconfig.tsbuildinfo,
// scripts/orphan-export-baseline.json and docs/wave44-audit.md, all prose or
// build residue.
//
// MERGED IN BEFORE DELETION: `getPersonaDescription()`'s 16-entry description
// map. It was the one thing that file had and this one lacked, and it is the
// block directly above (`PERSONA_DESCRIPTIONS`) — re-keyed to
// `StandardContactPersona`, which has exactly the same 16 members. Nothing was
// lost.
//
// The rest each collapse into a NAMED, MORE COMPLETE survivor:
//   CONTACT_TYPE_LABELS  → constants/crm-standards.ts:118 (this file)
//   CONTACT_PERSONA_LABELS → PERSONA_LABELS, constants/crm-standards.ts:99
//   STATUS_LABELS        → constants/crm-standards.ts:85
//   TIMELINE_LABELS      → constants/crm-standards.ts:130
//   getStatusColor()     → app/leads/page.tsx:671 and
//                          app/(external-portal)/components/os/external-active-files-panel.tsx:32,
//                          both LIVE and both already rendering the badge the
//                          lib copy was written for.
//   getUrgencyColor() / calculateDaysUntilTimeline() →
//                          app/dashboard/agent/components/conversion/newly-converted-contacts-panel.tsx:121
//                          and app/dashboard/communications/components/os/response-pressure-panel.tsx:44,
//                          again both LIVE.
//
// `getTimelineColor()` and `getTimelineUrgency()` had no survivor because they
// had no subject. They switch on `ContactTimeline` = "0-3_months" | "3-6_months"
// | "6-12_months" | "12+_months" (types/contact.ts:43), and NO WRITER IN THIS
// REPOSITORY PRODUCES THAT VOCABULARY on a row anyone reads. Every live consumer
// of a timeline tests the vocabulary in STANDARD_TIMELINES above, or free text:
//   lib/lead-promotion/initial-scorer.ts:69      `lead.timeline === 'immediate'`
//   lib/lead-governance/multi-factor-scorer.ts:100  same
//   lib/ai-isa/qualification-core.ts:59          same
//   lib/services/lead-management.service.ts:455  same
//   app/actions/lead-intelligence.ts:1311        assigns "immediate"
// Both functions were total switches with no default, so on any value the live
// scorers actually see they fell off the end and returned `undefined` — a badge
// class of `undefined`, an urgency of `undefined`. They could not have worked.
//
// OPEN, DELIBERATELY NOT DECIDED HERE: the vocabulary itself is still split two
// ways. This file (and every live scorer) says `immediate | 30_days | … |
// 12_plus_months`; `services/aiMappingService.ts:57` — which IS live, imported by
// services/supabaseService.ts:5 and normalizing values on the write path —
// declares its own `STANDARD_TIMELINES` as `0-3_months | … | 12+_months`, and
// types/contact.ts:43 plus lib/domain/types.ts:131 agree with IT. Reconciling
// them is a write-path change against a live normalizer, not a burn-down edit.
