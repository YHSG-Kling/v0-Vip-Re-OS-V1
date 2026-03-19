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
}
