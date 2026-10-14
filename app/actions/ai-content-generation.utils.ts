/**
 * Shared vocabularies for the content OS.
 *
 * These live OUTSIDE ai-content-generation.tsx on purpose: that file carries
 * "use server", and a non-function `export const` in a server-action module
 * breaks Next's page-data collection. Both the server actions and the UI
 * pickers import from here so a picker can never offer a value the server
 * (or the column's CHECK constraint) refuses.
 *
 * Every list below was verified against the live database.
 */

/**
 * ai_generated_content.status — NO check constraint in the database, so this
 * list is the only contract. Server validates against it; UI renders it.
 */
export const GENERATED_CONTENT_STATUSES = ["draft", "scheduled", "published", "archived"] as const
export type GeneratedContentStatus = (typeof GENERATED_CONTENT_STATUSES)[number]

/**
 * content_ab_tests.status — CHECK (status IN ('running','completed','cancelled')).
 * Verified live: inserting 'active' returns SQLSTATE 23514.
 */
export const AB_TEST_STATUSES = ["running", "completed", "cancelled"] as const
export type ABTestStatus = (typeof AB_TEST_STATUSES)[number]

/**
 * content_calendar.status — CHECK (status IN ('draft','scheduled','published','cancelled')).
 */
export const CONTENT_CALENDAR_STATUSES = ["draft", "scheduled", "published", "cancelled"] as const

/**
 * seo_keywords.keyword_type — CHECK (keyword_type IN
 * ('primary','secondary','long_tail','local','question')).
 */
export const SEO_KEYWORD_TYPES = ["primary", "secondary", "long_tail", "local", "question"] as const
export type SeoKeywordType = (typeof SEO_KEYWORD_TYPES)[number]

/**
 * seo_keywords.visibility_scope — CHECK (visibility_scope IN
 * ('agent','team','brokerage','multi_location','platform')).
 * NOTE: 'private' is NOT a member. Verified live: it returns SQLSTATE 23514.
 */
export const SEO_VISIBILITY_SCOPES = ["agent", "team", "brokerage", "multi_location", "platform"] as const

/** A/B test variables the variant generator knows how to rewrite. */
export const AB_TEST_VARIABLES = ["subject_line", "opening_hook", "cta", "length", "tone"] as const
export type ABTestVariable = (typeof AB_TEST_VARIABLES)[number]

/** Platforms the hashtag generator has per-platform rules for. */
export const HASHTAG_PLATFORMS = ["instagram", "facebook", "linkedin", "twitter", "tiktok"] as const
export type HashtagPlatform = (typeof HASHTAG_PLATFORMS)[number]

/** Description lengths accepted by the enhanced listing-description writer. */
export const DESCRIPTION_TYPES = ["short_mls", "standard", "extended", "social_snippet"] as const
export type DescriptionType = (typeof DESCRIPTION_TYPES)[number]
