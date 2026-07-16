// ============================================
// TYPES — Layer 8.1 AI Script Generator
// ============================================

export type ScriptType = 
  | "property_tour"
  | "buyer_education"
  | "market_update"
  | "agent_intro"
  | "listing_presentation"

/** KEEP-ONE: the canonical videoType → video_scripts_library.script_type map.
 * The live CHECK admits ONLY the five ScriptType values — every writer must
 * map through here (raw videoType strings like "listing_tour"/"custom"/"video"
 * violated the CHECK and the library save silently never persisted). */
export function toLibraryScriptType(videoType: string): ScriptType {
  const map: Record<string, ScriptType> = {
    full_tour: "property_tour",
    listing_tour: "property_tour",
    just_listed: "property_tour",
    listing_promo: "property_tour",
    open_house_promo: "property_tour",
    social_snippet: "property_tour",
    instagram_story: "property_tour",
    reel: "property_tour",
    buyer_education: "buyer_education",
    education: "buyer_education",
    market_update: "market_update",
    agent_intro: "agent_intro",
    welcome: "agent_intro",
    testimonial: "agent_intro",
    presentation: "listing_presentation",
    listing_presentation: "listing_presentation",
    presentation_chapter: "listing_presentation",
    property_tour: "property_tour",
  }
  return map[videoType] ?? "property_tour"
}

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

// ============================================
// VIDEO PERFORMANCE TRACKING — LAYER 8.5
// ============================================

// Supported event types for video_engagement_events
export const VIDEO_EVENT_TYPES = [
  "view",
  "pause",
  "complete",
  "click",
  "share",
  "lead_capture",
  "cta_click",
  "replay",
] as const

export type VideoEventType = (typeof VIDEO_EVENT_TYPES)[number]

// Performance thresholds for kernel events
export const PERFORMANCE_THRESHOLDS = {
  HIGH_PERFORMER: {
    minViews: 100,
    minCompletionRate: 70,
    minClickThroughRate: 5,
  },
  LOW_PERFORMER: {
    minViews: 50,
    maxCompletionRate: 20,
    maxClickThroughRate: 1,
  },
} as const
