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
