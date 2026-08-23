// ============================================
// SHARED CONSTANTS
// Central constants module for consistent values across all features
// ============================================

// ============================================
// DEMO MODE
// ============================================

// TOMBSTONE (orphan burn-down, lane E): `isDemoMode(userId)` and the
// `DEMO_USER_ID = "demo-user"` sentinel it compared against are DELETED. Both
// had zero callers, and the sentinel could never have matched anything: users.id
// is a uuid column, so no row can ever hold the literal string "demo-user" —
// isDemoMode returned false for every input it could legally be given.
//
// SURVIVOR: demo is a property of the BROKERAGE, not of a magic user id, and it
// is stored — brokerages.is_demo (boolean, live). The whole demo lane reads that
// column through lib/platform/demo-tenant.ts:
//   · :264 findDemoTenant / :269 `.eq("is_demo", true)` — locate the demo tenant
//   · :279 the HARD GUARD every destructive demo op re-checks against the DB
//   · :300 ensureDemoTenant, :371 seedDemoData, :416 resetDemoTenant,
//     :427 getDemoTenantSnapshot
// plus app/actions/superadmin/demo-tenant.ts and lib/platform/deal-room-demo.ts.
// That answer is persisted, tenant-scoped and re-verified at the point of use;
// a string compare in a client-importable constants barrel was none of those.
// Nothing merged — the deleted pair carried no fact the column does not.

// ============================================
// VALIDATION PATTERNS
// ============================================

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const PHONE_REGEX = /^\+?1?\d{10,14}$/
export const ZIPCODE_REGEX = /^\d{5}(-\d{4})?$/
export const URL_REGEX = /^https?:\/\/.+/

// ============================================
// FEATURE FLAGS
// ============================================

// ── REMOVED: `STRIPE_PAYMENTS` (NEXT_PUBLIC_FEATURE_STRIPE) ──────────────────
//
// A KILL SWITCH THAT SWITCHED NOTHING. Verified comment-stripped across all
// 5,373 .ts/.tsx files: `STRIPE_PAYMENTS` and `NEXT_PUBLIC_FEATURE_STRIPE`
// appeared in exactly ONE file — this one, the definition. Zero readers.
// ENV_CONFIGURATION.md:110 documented it to an operator as "Enable Stripe
// payments", so the one thing it did was promise a control that did not exist:
// setting it to "false" disabled nothing, and an operator reading that line
// would believe payments were off while every Stripe path kept running.
//
// SURVIVOR: lib/billing/stripe-subscription-ops.ts:23 `isStripeConfigured()` —
// the real gate, `!!process.env.STRIPE_SECRET_KEY`, read by
// app/actions/superadmin/brokerage-management.ts, app/actions/superadmin/
// coupons.ts and lib/billing/ai-overage.ts. Stripe is on when a key is present
// and off when it is not, which is the only condition the SDK can actually
// honour; a second boolean beside it could only ever disagree with it.
//
// Nothing was lost — no branch anywhere consulted this.
export const FEATURES = {
  DOTLOOP_INTEGRATION: process.env.NEXT_PUBLIC_FEATURE_DOTLOOP === "true",
  AI_CHAT: process.env.NEXT_PUBLIC_FEATURE_AI_CHAT !== "false", // Enabled by default
  CONTENT_GENERATION: process.env.NEXT_PUBLIC_FEATURE_CONTENT_GEN !== "false", // Enabled by default
  OPEN_HOUSE_AUTOMATION: process.env.NEXT_PUBLIC_FEATURE_OPEN_HOUSE !== "false", // Enabled by default
  SOCIAL_MEDIA: process.env.NEXT_PUBLIC_FEATURE_SOCIAL !== "false", // Enabled by default
  EMAIL_CAMPAIGNS: process.env.NEXT_PUBLIC_FEATURE_EMAIL !== "false", // Enabled by default
  // Buyer move-in: the guided-DIY concierge is always on. The Utility Connect EXTERNAL handoff (mode
  // 'handoff') stays OFF until the partner code + API creds exist — the recommendation still computes,
  // but no lead is ever pushed out while this is false. Flip on once the partner integration is live.
  BUYER_MOVE_UTILITY_CONNECT: process.env.NEXT_PUBLIC_FEATURE_UTILITY_CONNECT === "true",
} as const

// ============================================
// TRANSACTION TYPES
// ============================================

export const TRANSACTION_TYPES = ["listing", "buyer", "referral", "rental"] as const
export type TransactionType = (typeof TRANSACTION_TYPES)[number]

export const TRANSACTION_STATUSES = [
  "lead",
  "active",
  "under_contract",
  "pending",
  "closed",
  "withdrawn",
  "expired",
] as const
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number]

// ============================================
// CONTACT/LEAD TYPES
// ============================================

// 3-band — MUST match the lead_temperature CHECK constraint on contacts/leads/
// communication_audit_log (hot/warm/cold). "cool" belongs to the 4-band urgency_level
// scale, NOT lead_temperature; writing it here violates the constraint and the row drops.
export const LEAD_TEMPERATURES = ["hot", "warm", "cold"] as const
export type LeadTemperature = (typeof LEAD_TEMPERATURES)[number]

export const LEAD_SOURCES = [
  "website",
  "referral",
  "open_house",
  "social_media",
  "paid_ad",
  "organic_search",
  "email_campaign",
  "phone_call",
  "walk_in",
  "other",
] as const
export type LeadSource = (typeof LEAD_SOURCES)[number]

export const CONTACT_STATUSES = ["active", "archived", "deleted", "do_not_contact"] as const
export type ContactStatus = (typeof CONTACT_STATUSES)[number]

// ============================================
// PROPERTY TYPES
// ============================================

export const PROPERTY_TYPES = [
  "single_family",
  "condo",
  "townhouse",
  "multi_family",
  "land",
  "commercial",
  "other",
] as const
export type PropertyType = (typeof PROPERTY_TYPES)[number]

/** Human labels for the canonical values — the ONE place a property type is named. */
export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  single_family: "Single Family",
  condo:         "Condo",
  townhouse:     "Townhouse",
  multi_family:  "Multi-Family",
  land:          "Land / Lot",
  commercial:    "Commercial",
  other:         "Other",
}

/** Ready-made {value,label} options for any selector. */
export const PROPERTY_TYPE_OPTIONS: Array<{ value: PropertyType; label: string }> =
  PROPERTY_TYPES.map((value) => ({ value, label: PROPERTY_TYPE_LABELS[value] }))

/**
 * Coerce any historical spelling of a property type to its canonical value.
 *
 * Several surfaces stored the DISPLAY string ("Single Family", "Multi-Family") while
 * listings store the canonical value ("single_family"). The property-alert matcher
 * compares with `.toLowerCase()` on both sides, which LOOKS defensive but only fixes
 * case — the separator still differs, so "single family" never equalled "single_family".
 * The effect was a partially-working filter: Condo, Townhouse, Land and Commercial
 * matched because they are single words, while Single Family and Multi-Family — the two
 * most common residential types — silently scored zero on every listing. A filter that
 * works for some values is more misleading than one that works for none.
 *
 * Returns null for anything unrecognised rather than guessing, so a caller can decide
 * whether to ignore the value or surface it.
 */
export function canonicalPropertyType(raw: string | null | undefined): PropertyType | null {
  const key = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (!key) return null
  if ((PROPERTY_TYPES as readonly string[]).includes(key)) return key as PropertyType
  // Historical spellings that never had a canonical home.
  const ALIASES: Record<string, PropertyType> = {
    mobile_home:   "other",   // the home-value form offered this; no canonical equivalent
    manufactured:  "other",
    condo_townhome: "condo",
    townhome:      "townhouse",
    single_family_home: "single_family",
    multifamily:   "multi_family",
    lot:           "land",
  }
  return ALIASES[key] ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// THE LISTING PHASES — one vocabulary, in lifecycle order.
//
// There were THREE and none of them agreed:
//   · listings.status CHECK (10 values, the only one that decides a write)
//   · this constant (6 — missing listing_signed, withdrawn, cancelled, draft)
//     and with ZERO consumers, so it corrected nothing
//   · the status picker (7, including "under_contract" — which the column does
//     NOT admit, so choosing it produced a rejected write)
//
// under_contract is a TRANSACTION status, not a listing phase. The owner's
// stated process separates them: a LISTING moves listing_signed → coming_soon →
// active → pending → sold, exiting via withdrawn / cancelled / off_market /
// expired; a TRANSACTION moves under_contract → pending → clear_to_close →
// closed_sold → funded. Offering a transaction status on a listing conflated
// the two and could never save.
//
// This list is now the full admitted set, matched to the CHECK, and it is USED:
// the picker renders from it and updateListingStatus validates against it, so a
// value that cannot be stored can no longer be offered or submitted.
export const LISTING_STATUSES = [
  "draft",
  "listing_signed",
  "coming_soon",
  "active",
  "pending",
  "sold",
  "withdrawn",
  "cancelled",
  "off_market",
  "expired",
] as const
export type ListingStatus = (typeof LISTING_STATUSES)[number]

/** Display labels for the phases above — kept beside the vocabulary so a new
 *  phase cannot be added without a label, or labelled without existing. */
export const LISTING_STATUS_LABELS: Record<ListingStatus, string> = {
  draft:          "Draft",
  listing_signed: "Listing Signed",
  coming_soon:    "Coming Soon",
  active:         "Active",
  pending:        "Pending",
  sold:           "Sold",
  withdrawn:      "Withdrawn",
  cancelled:      "Cancelled",
  off_market:     "Off Market",
  expired:        "Expired",
}

/** PURE — is this a phase a listing may actually be set to? */
export function isListingStatus(value: string): value is ListingStatus {
  return (LISTING_STATUSES as readonly string[]).includes(value)
}

// ============================================
// CONTENT TYPES
// ============================================

export const CONTENT_TYPES = [
  "listing_description",
  "social_post",
  "email",
  "video_narration",
  "blog_post",
  "marketing_flyer",
] as const
export type ContentType = (typeof CONTENT_TYPES)[number]

export const SOCIAL_PLATFORMS = ["facebook", "instagram", "linkedin", "twitter", "tiktok"] as const
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]

/** @deprecated Use SOCIAL_PLATFORMS */
export const SOCIAL_MEDIA_PLATFORMS = SOCIAL_PLATFORMS

export const EMAIL_TYPES = [
  "welcome",
  "listing_alert",
  "open_house",
  "price_drop",
  "sold",
  "follow_up",
  "birthday",
  "anniversary",
  "market_update",
] as const
export type EmailType = (typeof EMAIL_TYPES)[number]

// ============================================
// VIDEO TYPES
// ============================================

export const VIDEO_TYPES = [
  "full_tour",
  "social_snippet",
  "instagram_story",
  "reel",
  "drone_highlight",
  "agent_intro",
] as const
export type VideoType = (typeof VIDEO_TYPES)[number]

export const VIDEO_STATUSES = ["queued", "processing", "ready", "failed", "published"] as const
export type VideoStatus = (typeof VIDEO_STATUSES)[number]

// ============================================
// OPEN HOUSE TYPES
// ============================================

export const OPEN_HOUSE_STATUSES = ["scheduled", "in_progress", "completed", "cancelled"] as const
export type OpenHouseStatus = (typeof OPEN_HOUSE_STATUSES)[number]

// ============================================
// CAMPAIGN TYPES
// ============================================

export const CAMPAIGN_TYPES = ["one_time", "recurring", "drip_sequence", "triggered"] as const
export type CampaignType = (typeof CAMPAIGN_TYPES)[number]

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "running", "paused", "completed", "archived"] as const
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]

// ============================================
// ERROR MESSAGES
// ============================================

export const ERROR_MESSAGES = {
  // Validation Errors
  INVALID_UUID: "Invalid ID format. Expected UUID.",
  INVALID_EMAIL: "Invalid email format.",
  INVALID_PHONE: "Invalid phone number format.",
  INVALID_ZIPCODE: "Invalid zip code format.",
  INVALID_URL: "Invalid URL format.",
  INVALID_PRICE: "Invalid price value.",
  INVALID_DATE: "Invalid date format.",

  // Permission Errors
  UNAUTHORIZED: "You do not have permission to perform this action.",
  FORBIDDEN: "Access to this resource is forbidden.",
  NOT_AUTHENTICATED: "You must be logged in to perform this action.",

  // Resource Errors
  NOT_FOUND: "The requested resource was not found.",
  ALREADY_EXISTS: "A resource with this identifier already exists.",
  DELETED: "This resource has been deleted.",

  // Operation Errors
  OPERATION_FAILED: "The operation could not be completed.",
  DATABASE_ERROR: "A database error occurred.",
  NETWORK_ERROR: "A network error occurred.",

  // Feature Errors
  FEATURE_DISABLED: "This feature is currently disabled.",
  DEMO_MODE_RESTRICTION: "This action is not available in demo mode.",

  // Content Errors
  CONTENT_TOO_SHORT: "Content is too short.",
  CONTENT_TOO_LONG: "Content exceeds maximum length.",
  INVALID_CONTENT_TYPE: "Invalid content type.",

  // Integration Errors
  INTEGRATION_ERROR: "An error occurred with the external integration.",
  API_KEY_MISSING: "API key is missing or invalid.",
  RATE_LIMIT_EXCEEDED: "Rate limit exceeded. Please try again later.",
} as const

// ============================================
// SUCCESS MESSAGES
// ============================================

export const SUCCESS_MESSAGES = {
  CREATED: "Successfully created.",
  UPDATED: "Successfully updated.",
  DELETED: "Successfully deleted.",
  SENT: "Successfully sent.",
  PUBLISHED: "Successfully published.",
  SCHEDULED: "Successfully scheduled.",
  SAVED: "Successfully saved.",
  SYNCED: "Successfully synced.",
} as const

// ============================================
// LIMITS & PAGINATION
// ============================================

export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  MIN_PAGE_SIZE: 1,
} as const

export const CONTENT_LIMITS = {
  EMAIL_SUBJECT_MAX: 150,
  EMAIL_BODY_MAX: 10000,
  SOCIAL_POST_TWITTER: 280,
  SOCIAL_POST_FACEBOOK: 63206,
  SOCIAL_POST_INSTAGRAM: 2200,
  SOCIAL_POST_LINKEDIN: 3000,
  DESCRIPTION_SHORT: 500,
  DESCRIPTION_STANDARD: 2000,
  DESCRIPTION_EXTENDED: 5000,
  HASHTAGS_MAX: 30,
  HASHTAG_LENGTH_MAX: 50,
} as const

export const FILE_LIMITS = {
  IMAGE_MAX_SIZE: 10 * 1024 * 1024, // 10MB
  VIDEO_MAX_SIZE: 500 * 1024 * 1024, // 500MB
  DOCUMENT_MAX_SIZE: 50 * 1024 * 1024, // 50MB
} as const

// ============================================
// TIME CONSTANTS
// ============================================

export const TIME = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000,
} as const

export const CACHE_TTL = {
  SHORT: 5 * TIME.MINUTE,
  MEDIUM: 30 * TIME.MINUTE,
  LONG: 2 * TIME.HOUR,
  VERY_LONG: 24 * TIME.HOUR,
} as const

export const AI_LIMITS = {
  MAX_TOKENS: 4096,
  TEMPERATURE: 0.7,
  MAX_RETRIES: 3,
} as const

export const AI_CONFIG = {
  defaultModel: 'claude-sonnet-4-20250514',
  maxTokensDefault: 1000,
  temperatureDefault: 0.7,
  features: {
    videoScriptGeneration: true,
    brandVoiceApplication: true,
    complianceCheck: true,
  }
} as const


