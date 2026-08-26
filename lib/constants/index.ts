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

// TOMBSTONE (orphan burn-down, lane BC, 2026-08-26): EMAIL_REGEX, PHONE_REGEX,
// ZIPCODE_REGEX and URL_REGEX are DELETED. All four were exported by this
// barrel and imported by NOTHING (verified comment-stripped across app/ lib/
// hooks/ types/ constants/ — the only occurrences were these definitions).
//
// SURVIVORS — the same patterns, already live, already called:
//   · EMAIL_REGEX   → lib/validations/index.ts:99  isValidEmail, holding the
//                     BYTE-IDENTICAL /^[^\s@]+@[^\s@]+\.[^\s@]+$/ (re-exported
//                     as validateEmail at :106; called from app/actions/
//                     ai-newsletter.ts:1326 and :1659 among others).
//   · PHONE_REGEX   → lib/validations/index.ts:109 isValidPhone, holding the
//                     byte-identical /^\+?1?\d{10,14}$/ AND stripping spaces,
//                     dashes and parens before testing — strictly more correct
//                     than the bare pattern deleted here. E.164 normalisation
//                     for the ads/PII lane lives at
//                     lib/ads/connectors/pii.ts:32 normalizePhoneE164.
//   · ZIPCODE_REGEX → lib/validations/index.ts:131 isValidZipcode, byte-identical
//                     /^\d{5}(-\d{4})?$/ (also app/actions/settings/
//                     brokerage-identity.ts:196 ZIP_PATTERN).
//   · URL_REGEX     → the shape is applied at the seams that actually validate a
//                     URL, e.g. lib/marketing/image-library.ts:72 and
//                     app/actions/superadmin/platform-social.ts:167 (both the
//                     byte-identical /^https?:\/\/.+/), app/actions/
//                     content-intel/sources.ts:153, app/actions/user-profile.ts:72.
//
// Nothing merged: each survivor already carried the whole pattern. UUID_REGEX
// stays because it HAS importers — note it is itself duplicated at
// lib/validations/index.ts:83, which is a §6 defect left for a lane that can
// repoint the importers.

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

// ── LEAD SOURCE — the AGENT-FACING pick list for contacts.source ─────────────
//
// MEASURED FIRST (live, hrvaqgvukzxfskkcrwbt, 2026-08-25):
//   · There is NO CHECK CONSTRAINT on contacts.source, and none on leads.source
//     either. `leads` carries source_family and source_origin CHECKs — neither
//     constrains `source`. So this list is erased at the HTTP boundary: it can
//     only bind anything if code CALLS it. That is why normalizeLeadSource
//     exists below and is invoked at the write seam, rather than this array
//     sitting here looking authoritative.
//   · Live contacts.source values: referral(2), open_house(1), website_widget(1).
//
// THREE SPELLINGS OF ONE IDEA WERE MERGED ONTO THIS ARRAY (CLAUDE.md §6):
//   1. this list (10 values) — had TWO importers and ZERO uses; both imports
//      were dead, so nothing was validated anywhere.
//   2. app/crm/contacts/new/page.tsx — a private copy adding zillow,
//      realtor_com, cold_call, door_knock and dropping four of this list's.
//   3. app/dashboard/acquisition/acquisition-quick-capture.tsx `SOURCES` —
//      a third copy adding business_card and event.
// Both duplicates now import this array; their extra values are folded in here
// so the merge LOSES NOTHING (§1.1 — merge onto the survivor before deleting).
//
// "manual" IS LOAD-BEARING AND WAS MISSING FROM ALL THREE. It is what the
// product's own kernel writes by default — lib/kernel/crm.ts:396
// `params.source_label ?? "manual"`, reached from app/actions/contacts.ts
// createContact. Wiring the old 10-value list as-is would have started REFUSING
// the default value the product writes on every manually-added contact.
export const LEAD_SOURCES = [
  "manual",          // kernel default — lib/kernel/crm.ts:396. Do not remove.
  "website",
  "referral",
  "open_house",
  "social_media",
  "paid_ad",
  "organic_search",
  "email_campaign",
  "phone_call",
  "walk_in",
  "business_card",   // merged from acquisition-quick-capture SOURCES
  "event",           // merged from acquisition-quick-capture SOURCES
  "zillow",          // merged from crm/contacts/new LEAD_SOURCES
  "realtor_com",     // merged from crm/contacts/new LEAD_SOURCES
  "cold_call",       // merged from crm/contacts/new LEAD_SOURCES
  "door_knock",      // merged from crm/contacts/new LEAD_SOURCES
  "other",
] as const
export type LeadSource = (typeof LEAD_SOURCES)[number]

/** Display labels — the only lead-source wording the UI may use. */
export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  manual:          "Manually Added",
  website:         "Website",
  referral:        "Referral",
  open_house:      "Open House",
  social_media:    "Social Media",
  paid_ad:         "Paid Ad",
  organic_search:  "Organic Search",
  email_campaign:  "Email Campaign",
  phone_call:      "Phone Call",
  walk_in:         "Walk In",
  business_card:   "Business Card",
  event:           "Event",
  zillow:          "Zillow",
  realtor_com:     "Realtor.com",
  cold_call:       "Cold Call",
  door_knock:      "Door Knock",
  other:           "Other",
}

/**
 * Non-canonical spellings folded onto canonical ones.
 *
 * DELIBERATELY MINIMAL — every entry is a spelling MEASURED in the live column
 * or in one of the three merged pick lists, never one invented because it
 * seemed plausible. `website_widget` is the live value written by the site
 * capture widget; it is the same idea as the pickers' `website` (§6), so it
 * folds rather than becoming an eighteenth vocabulary member.
 */
export const LEAD_SOURCE_ALIASES: Readonly<Record<string, LeadSource>> = {
  website_widget: "website",
}

/**
 * THE HALF THAT ACTUALLY BINDS. Returns the canonical LeadSource, or null when
 * the value is not in the vocabulary.
 *
 * Because there is no CHECK on contacts.source, a `"use server"` export — i.e.
 * a public HTTP endpoint (§4) — is the LAST place a bad value can be stopped.
 * Callers must treat null as a refusal, not fold it to "other": silently
 * rewriting an attribution value is how a vocabulary drifts in the first place.
 */
export function normalizeLeadSource(raw: string | null | undefined): LeadSource | null {
  if (raw === null || raw === undefined) return null
  const key = String(raw).trim().toLowerCase()
  if (!key) return null
  if ((LEAD_SOURCES as readonly string[]).includes(key)) return key as LeadSource
  return LEAD_SOURCE_ALIASES[key] ?? null
}

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

/** Human labels for the canonical values — the ONE place a property type is named.
 *
 *  UN-EXPORTED 2026-08-26 (orphan burn-down, lane BC). The VALUE is live — it is
 *  what PROPERTY_TYPE_OPTIONS below is built from, and that IS imported (three
 *  surfaces: app/components/form-wizard/FormWizard.tsx:52,
 *  app/components/home-value/AddressSearchForm.tsx:21,
 *  app/crm/contacts/[contactId]/alerts/page.tsx:69). What was orphaned was the
 *  EXPORT: no file anywhere imported this name (verified comment-stripped across
 *  app/ lib/ hooks/ types/ constants/ — the only two occurrences were this
 *  declaration and the .map() below it). So the half deleted is the public
 *  binding, not the map; nothing moved and no survivor is owed, because the one
 *  consumer is eight lines down in this file. A selector that wants a label
 *  takes PROPERTY_TYPE_OPTIONS, which carries it. */
const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
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

// TOMBSTONE: `SOCIAL_MEDIA_PLATFORMS` — DELETED as a duplicate spelling.
// SURVIVOR: SOCIAL_PLATFORMS, lib/constants/index.ts:248 — the same array; the
// alias was `export const SOCIAL_MEDIA_PLATFORMS = SOCIAL_PLATFORMS` and carried
// its own `@deprecated Use SOCIAL_PLATFORMS` note. Its one importer
// (lib/services/social-publishing.service.ts) never called it; that file now
// imports the survivor and validates against it before publishing. Two names for
// one platform vocabulary is exactly what CLAUDE.md §6 forbids.

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

// TOMBSTONE (orphan burn-down, lane BC, 2026-08-26): VIDEO_STATUSES and
// VideoStatus are DELETED — a SECOND video-status vocabulary, which §6 names as
// the exact defect that has already bitten this lane ("video status (22
// spellings)"). Neither the const nor the type was imported by any file.
//
// SURVIVOR: lib/video/video-status.ts:72 CANONICAL_VIDEO_STATUSES /
// :84 CanonicalVideoStatus — the nine values mirrored by the m374 CHECK on
// ai_video_projects.status, with isCanonicalVideoStatus (:86) and
// normalizeVideoStatus (:141) as the gate and the migrator.
//
// MERGED FIRST, then deleted (§1.1): of the five words this list spelled,
// `queued`, `failed` and `published` are canonical there already and `ready`
// was already mapped (→ "completed"). The ONE spelling the survivor was missing
// was `processing`; it is now an entry in RETIRED_VIDEO_STATUS → "generating"
// (lib/video/video-status.ts, "in flight at a provider" block). Checked against
// the live database (hrvaqgvukzxfskkcrwbt, 2026-08-26): ai_video_projects holds
// ZERO rows, so no backfill was owed and the entry is a mapping record only.

// ============================================
// OPEN HOUSE TYPES
// ============================================

// TOMBSTONE (orphan burn-down, lane BC, 2026-08-26): OPEN_HOUSE_STATUSES and
// OpenHouseStatus are DELETED. Neither was imported by any file, and the list
// was a SECOND open-house status vocabulary that the database would have
// refused: it spelled "in_progress", which is not in the live CHECK — a write
// through this list would have been rejected outright.
//
// SURVIVOR: open_house_events.status, whose CHECK is the vocabulary
//   ['draft','scheduled','marketing','active','completed','cancelled']
// (measured live, hrvaqgvukzxfskkcrwbt 2026-08-26:
// open_house_events_status_check), mirrored in the GENERATED cache at
// scripts/check-vocabularies.ts:1062 and enforced by test:check-vocabulary.
// open_house_events is the consolidation survivor named in
// lib/kernel/manager-registry.ts:482 (open_house_single_event_table).
//
// NOTHING MERGED, deliberately: the survivor's word for the state this list
// called "in_progress" is "active", and adding a fourth spelling to a
// CHECK-backed vocabulary is the §6 defect, not the fix.

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

// TOMBSTONE (orphan burn-down, lane BC, 2026-08-26): AI_LIMITS and AI_CONFIG are
// DELETED. Neither was imported by any file — the only occurrences of either name
// anywhere under app/ lib/ hooks/ types/ constants/ were these two declarations,
// verified comment-stripped. Both were second hand-kept copies of settings the AI
// lane already owns, and AI_CONFIG in particular is the exact shape §2 warns about:
// a client-importable barrel PINNING a model id ('claude-sonnet-4-20250514') beside
// the real registry, where it can drift without anything noticing because nothing
// reads it.
//
// SURVIVORS — each field named, so nothing is "deleted to move a number":
//   · defaultModel / model choice     → lib/ai/models.ts:26 MODEL_CONFIG (the one
//     alias→provider/model table) resolved through lib/ai/resolve-model.ts:85
//     resolveModel(), which every call site already goes through; and
//     process.env.AI_GATEWAY_DEFAULT_MODEL for the ISA outreach lane
//     (lib/ai-isa/personalize-outreach.ts:214). Pricing and the served-model
//     identity read MODEL_CONFIG too (lib/ai/models.ts:209 modelIdentityFor) —
//     §5 makes that ledger an invoice input, so a second model table is a wrong
//     invoice waiting to happen.
//   · MAX_TOKENS / maxTokensDefault   → per-call `maxTokens` on the generate
//     options (lib/ai/generate.ts and its callers, e.g. app/actions/
//     ai-generate.ts:30). There is no one right ceiling: a 400-token reply and a
//     4096-token script are both correct, which is why the value belongs at the
//     call and not in a barrel.
//   · TEMPERATURE / temperatureDefault→ same: the per-call `temperature` option.
//   · MAX_RETRIES                     → lib/errors/auto-retry.ts owns retry policy.
//   · features.{videoScriptGeneration,brandVoiceApplication,complianceCheck}
//     → kill switches that switched nothing, the same defect the STRIPE_PAYMENTS
//     tombstone above records. All three capabilities are unconditionally live
//     and gated by real state, not by this object: video scripting runs through
//     lib/kernel/video.ts, brand voice through the brand-voice cascade
//     (test:brand-voice-cascade), and the compliance check through the
//     compliance-first script gate (test:script-compliance-first). Nothing read
//     these booleans, so setting one false would have disabled nothing while
//     telling a reader it had.
//
// Nothing merged: every survivor already carries the whole setting.


