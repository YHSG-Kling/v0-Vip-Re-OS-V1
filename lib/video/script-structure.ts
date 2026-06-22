/**
 * lib/video/script-structure.ts
 *
 * Pure, deterministic helpers for AI video-script generation. Extracted from the
 * "use server" action app/actions/video/generate-script.ts so they can be unit-tested
 * without an LLM call, a DB, or any session context.
 *
 * A "use server" file may only export async functions, so these constants/pure
 * functions live here and are imported by the action.
 */

/** Canonical video types the script generator supports. */
export type VideoScriptType =
  | "property_tour"
  | "market_update"
  | "agent_intro"
  | "listing_presentation"
  | "buyer_education"
  | "seller_update"
  | "testimonial"
  | "tips"
  | "custom"

/** Delivery tones the script generator supports. */
export type VideoScriptTone = "professional" | "friendly" | "luxury" | "educational"

/** Input shape for the generateVideoScript server action. */
export interface GenerateVideoScriptParams {
  brokerageId: string
  agentId: string
  userId: string
  /** What the video is about — free-text brief from the user */
  description: string
  /** Canonical video type */
  videoType: VideoScriptType
  /** Delivery tone */
  tone: VideoScriptTone
  /** Target duration in seconds — controls word-count target */
  targetDurationSeconds?: number
  /** Optional listing context pre-fill */
  listingContext?: {
    address: string
    city: string
    state: string
    listPrice: number
    bedrooms?: number
    bathrooms?: number
    sqft?: number
    features?: string[]
  }
  /** Optional brand voice tone from ai_identity_profiles */
  brandVoiceTone?: string
  saveToLibrary?: boolean
}

/** Result shape returned by the generateVideoScript server action. */
export interface GenerateVideoScriptResult {
  success: boolean
  script?: string
  wordCount?: number
  estimatedDurationSeconds?: number
  savedScriptId?: string
  error?: string
  complianceBlocked?: boolean
  /** Advisory compliance notes from post-generation check — not a hard block */
  complianceWarnings?: string[]
}

/** Average speaking pace used to convert between duration and word count. */
export const WORDS_PER_MINUTE = 150

/** Tone → system-prompt directive. */
export const TONE_INSTRUCTIONS: Record<VideoScriptTone, string> = {
  professional: "Use a polished, authoritative tone. Speak with confidence and expertise. Avoid slang.",
  friendly:
    "Use a warm, conversational tone. Speak as if talking to a friend. Be approachable and genuine.",
  luxury:
    "Use elevated, aspirational language. Evoke exclusivity and lifestyle. Focus on the experience, not just facts.",
  educational:
    "Use a clear, informative tone. Explain concepts simply. Use structure (numbered points where helpful).",
}

/**
 * Map a video type to the synthetic broadcast contact_type. This determines the
 * audience/journey context the compliance gate evaluates the script against.
 * Seller-facing content → "seller"; everything else defaults to "buyer".
 */
export function videoTypeToContactType(videoType: VideoScriptType): "buyer" | "seller" {
  switch (videoType) {
    case "seller_update":
    case "listing_presentation":
      return "seller"
    default:
      return "buyer"
  }
}

/**
 * Target word count for a given spoken duration, at WORDS_PER_MINUTE pace.
 * 150 words ≈ 60 seconds (2.5 words/second).
 */
export function targetWordCount(durationSeconds: number): number {
  return Math.round((durationSeconds / 60) * WORDS_PER_MINUTE)
}

/**
 * Estimate spoken duration (seconds) for a written word count, at WORDS_PER_MINUTE pace.
 * Inverse of targetWordCount.
 */
export function estimateDurationSeconds(wordCount: number): number {
  return Math.round((wordCount / WORDS_PER_MINUTE) * 60)
}
