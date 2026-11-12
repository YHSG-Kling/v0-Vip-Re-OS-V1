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
  // ── MERGED ONTO THE SURVIVOR ──────────────────────────────────────────────
  // These three were declared on a DUPLICATE `VideoScript` interface local to
  // app/dashboard/videos/library/page.tsx, which existed only because this one
  // did not carry them; that page then double-cast every row
  // (`rows as unknown as VideoScript[]`) to get past the mismatch. They are the
  // three fields app/actions/video-generation.ts:getVideoScriptLibrary actually
  // maps onto each row, so they belong here and the duplicate is deleted.
  /** Derived by getVideoScriptLibrary from the `script_variations(id)` embed. */
  variation_count?: number
  /** The `video_templates(...)` embed, flattened by the readers to one name. */
  template?: { id: string; template_name: string; category: string } | null
  /** Present only on the by-id read, which embeds the variations in full. */
  script_variations?: ScriptVariation[]
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

/**
 * WHAT "VIRAL" MEANS, IN ONE PLACE.
 *
 * The owner's ruling: "if the video goes viral using that script, it should be
 * shared to the whole brokerage." That needs a number, and a number that lives
 * at a call site is a number nobody can change on purpose — so it lives here,
 * next to the thresholds it is a sibling of, and lib/video/viral-script-share.ts
 * imports it rather than restating it.
 *
 * THIS IS A PRODUCT PARAMETER, NOT A CONSTANT OF NATURE. It is the audience size
 * at which one agent's script stops being their private work and becomes
 * something their whole brokerage should have. Moving it is a product decision;
 * it is not tuning.
 *
 * WHY total_views AND NOT A BETTER METRIC. Measured against the live database,
 * not assumed:
 *
 *   · `video_performance_tracking.total_views` is incremented by +1 per 'view'
 *     event by BOTH engagement writers — app/actions/video-generation.ts
 *     :recordVideoEngagementEvent and POST /api/video/engagement. It is really
 *     recorded.
 *   · `share_rate` would be the more natural reading of "viral", and it is NOT
 *     usable: both writers compute it as a PERCENTAGE by round-tripping through
 *     the previous percentage
 *     (`Math.floor(share_rate * views / 100) + 1`, then `/ views`), so it loses
 *     the share COUNT it was derived from and cannot be compared against an
 *     absolute. Naming it here would be picking a number off a lossy field.
 *   · `ai_video_projects.view_count` exists, is NOT NULL, and NOTHING in the
 *     tree writes it. Reading it would be inventing a counter with no producer.
 *
 * So the honest metric is total_views, and the threshold is stated against it.
 * It is deliberately HIGHER than PERFORMANCE_THRESHOLDS.HIGH_PERFORMER.minViews
 * (100): "this video is doing well, tell the agent" and "this script now belongs
 * to the brokerage" are different claims, and the second one takes work away
 * from its author's exclusive use.
 */
export const VIRAL_VIEW_THRESHOLD = 1000
