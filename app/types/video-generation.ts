// ============================================
// TYPES — Layer 8.1 AI Script Generator
// ============================================

export type ScriptType = 
  | "property_tour"
  | "buyer_education"
  | "market_update"
  | "agent_intro"
  | "listing_presentation"

export type ApprovalStatus = 
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"

export interface VideoScript {
  id: string
  brokerage_id: string
  agent_id: string | null
  listing_id: string | null
  contact_id: string | null
  template_id: string | null
  script_type: ScriptType
  title: string
  script_content: string
  duration_target_seconds: number | null
  brand_voice_tone: string | null
  approval_status: ApprovalStatus
  compliance_review_notes: string | null
  required_brand_assets: Record<string, any> | null
  ai_generated: boolean
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface ScriptVariation {
  id: string
  script_library_id: string
  brokerage_id: string
  variation_label: string
  variation_goal: string | null
  script_content: string
  call_to_action: string | null
  audience_segment: string | null
  is_ab_test: boolean
  performance_notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}
