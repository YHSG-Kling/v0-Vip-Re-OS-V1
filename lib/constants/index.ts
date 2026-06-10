// ============================================
// SHARED CONSTANTS
// Central constants module for consistent values across all features
// ============================================

// ============================================
// DEMO MODE
// ============================================

export const DEMO_USER_ID = "demo-user"
export const isDemoMode = (userId: string | null | undefined) => userId === DEMO_USER_ID

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

export const FEATURES = {
  DOTLOOP_INTEGRATION: process.env.NEXT_PUBLIC_FEATURE_DOTLOOP === "true",
  STRIPE_PAYMENTS: process.env.NEXT_PUBLIC_FEATURE_STRIPE === "true",
  AI_CHAT: process.env.NEXT_PUBLIC_FEATURE_AI_CHAT !== "false", // Enabled by default
  CONTENT_GENERATION: process.env.NEXT_PUBLIC_FEATURE_CONTENT_GEN !== "false", // Enabled by default
  OPEN_HOUSE_AUTOMATION: process.env.NEXT_PUBLIC_FEATURE_OPEN_HOUSE !== "false", // Enabled by default
  SOCIAL_MEDIA: process.env.NEXT_PUBLIC_FEATURE_SOCIAL !== "false", // Enabled by default
  EMAIL_CAMPAIGNS: process.env.NEXT_PUBLIC_FEATURE_EMAIL !== "false", // Enabled by default
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

export const LEAD_TEMPERATURES = ["hot", "warm", "cool", "cold"] as const
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

export const LISTING_STATUSES = ["coming_soon", "active", "pending", "sold", "off_market", "expired"] as const
export type ListingStatus = (typeof LISTING_STATUSES)[number]

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


