/**
 * Lead Management Types
 * Exported separately from server actions to comply with "use server" restrictions
 */

export type LeadScore = 1 | 2 | 3 | 4 | 5
export type LeadIntent = "buying" | "selling" | "distress" | "investor"
export type LeadStatus = "new" | "enriched" | "qualified" | "converted" | "rejected"
export type LeadSource = "scraped" | "website_form" | "ghl" | "manual"

export interface Lead {
  id: string
  source: LeadSource
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  ai_score: LeadScore
  intent: LeadIntent | null
  status: LeadStatus
  created_at: string
  enriched_data?: any
  agent_id: string
  lead_stage?: string | null
  is_active?: boolean
  reengagement_status?: string | null
  lifecycle_state?: string | null
  assigned_agent_id?: string | null
  // Merged 2026-09-01 from the deleted lib/domain/types.ts Lead (§1.1): the
  // enrichment/conversion fields it documented that are REAL leads columns
  // (verified against scripts/schema-snapshot.ts). Its urgency_score, location,
  // external_id, assigned_to_agent_id, assigned_at and converted_to_contact_id
  // were NOT merged — no such columns exist (the live spellings are
  // urgency_level, city/state/zip_code, raw_record_id, agent_id,
  // handed_to_agent_at and contact_id).
  lead_score?: number | null
  budget_min?: number | null
  budget_max?: number | null
  timeline?: string | null
  property_type?: string | null
  updated_at?: string
  last_activity_at?: string | null
  converted_at?: string | null
  contact_id?: string | null
  [key: string]: any
}
