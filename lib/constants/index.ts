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

// TOMBSTONE (§1.1 + §6, 2026-08-31, lane M4): `TRANSACTION_STATUSES` and its
// derived `TransactionStatus` type deleted — a stale second spelling of the
// deal-status vocabulary. SURVIVOR: lib/transactions/transaction-status.ts,
// the m291 CHECK-backed list (lead, qualifying, active, under_contract,
// pending, clear_to_close, closed, funded, lost, archived). The one importer,
// lib/services/transaction-management.service.ts, is repointed onto it.
// NOTHING MERGED, deliberately: the two values only this copy had —
// "withdrawn" and "expired" — are LISTING-inventory words (a listing is
// withdrawn; a deal is lost or archived); the DB CHECK refuses them, so
// carrying them into the survivor would re-open the very hole the validator
// exists to close. Recorded here per the differing-value rule.

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
  // ── SECOND MERGE WAVE (2026-08-29) ─────────────────────────────────────────
  // Two MORE copies of this vocabulary were still standing after the first
  // merge, and neither was reachable from anything: constants/crm-standards.ts
  // `STANDARD_SOURCES` (12 values) and services/aiMappingService.ts
  // `STANDARD_SOURCES` (7 values). They hid from the orphan census by acquitting
  // EACH OTHER — both spell the identifier `STANDARD_SOURCES`, and the census
  // asks "does this name occur in another file?", not "does that file reach my
  // module?". Four ideas this list genuinely lacked are folded in below so the
  // merge loses nothing (§1.1); the rest were spellings of members already here
  // and became LEAD_SOURCE_ALIASES entries instead of a fifth vocabulary.
  //
  // The two PREMIER values are NOT duplicates of the plain portal values beside
  // them: Zillow Premier Agent and Realtor.com Connections are PAID lead
  // products, and folding them into "zillow"/"realtor_com" would erase the only
  // distinction source-ROI reporting has between a paid lead and an organic one.
  "sphere",              // merged from crm-standards STANDARD_SOURCES — Sphere of Influence
  "past_client",         // merged from crm-standards STANDARD_SOURCES
  "zillow_premier",      // merged from crm-standards STANDARD_SOURCES — PAID, ≠ "zillow"
  "realtor_com_premier", // merged from crm-standards STANDARD_SOURCES — PAID, ≠ "realtor_com"
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
  // Wording taken verbatim from constants/crm-standards.ts SOURCE_LABELS, the
  // map these four arrived with, so the merge changed no user-visible string.
  sphere:              "Sphere of Influence",
  past_client:         "Past Client",
  zillow_premier:      "Zillow Premier",
  realtor_com_premier: "Realtor.com Premier",
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
  // Measured in services/aiMappingService.ts STANDARD_SOURCES, the fifth copy,
  // deleted 2026-08-29. Both are SPELLINGS of members this list already has —
  // they fold rather than widening the vocabulary (§6).
  social: "social_media",
  "realtor.com": "realtor_com",
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

// TOMBSTONE (orphan doctrine §1.1, 2026-08-31) — `CONTACT_STATUSES` /
// `ContactStatus` deleted from this file. Imported by NOTHING (grepped on
// stripped source), and its four members were a fragment of the real roster
// (it lacked 'new'/'contacted'/'nurture'/'qualified' — the values live writers
// actually store — and carried 'do_not_contact', which no writer ever stored;
// the DNC fact is the dnc_status column). SURVIVOR:
// lib/contact-promotion/qualification.ts CONTACT_STATUSES — the vocabulary the
// m587 CHECK enforces.

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

// TOMBSTONE (orphan burn-down, lane H5, 2026-08-28): EMAIL_TYPES and EmailType
// are DELETED. Neither had a single reference anywhere in the tree — verified
// comment-stripped across app/ lib/ hooks/ types/ constants/ components/
// services/ workflows/ contexts/ remotion/ scripts/; the only occurrences of
// either name were these two declarations. This was a SECOND hand-kept
// vocabulary for "what kind of email is this", the exact defect CLAUDE.md §6
// names, and it disagreed with the live one at the spelling level: it said
// `follow_up` where the database says `followup`, so nothing could ever have
// matched across the two.
//
// SURVIVORS — each of the nine words placed, so nothing is deleted to move a
// number:
//   · TEMPLATE KIND (`welcome`, `follow_up`, and the rest of the transactional
//     shapes) → email_templates.template_type, a LIVE CHECK admitting
//     ["closing", "followup", "offer", "reminder", "welcome"] — mirrored in the
//     generated cache scripts/check-vocabularies.ts:700. That is what actually
//     decides a stored row; a TypeScript array never could.
//   · CAMPAIGN SHAPE (`market_update`, a recurring send) → email_campaigns
//     .campaign_format ["drip", "event_triggered", "one_off", "segmented",
//     "transactional"] (check-vocabularies.ts:686).
//   · SEND OUTCOME → email_sends.status / email_tracking.event_type.
//   · `listing_alert` and `open_house` are LEAD-MAGNET kinds, not email kinds:
//     lib/kernel/lead-magnets.ts:25 owns that union and lib/marketing/
//     lead-magnet-copy.ts:93 carries their copy.
//   · `price_drop` / `sold` are LISTING lifecycle events, carried by the
//     listing-stage vocabulary, and `birthday` / `anniversary` are relationship
//     moments — `home_anniversary` is a live ai_video_projects.video_type value
//     (m565) and contacts.home_anniversary is the column behind it.
// NOTHING WAS MERGED because nothing was missing: no writer in the tree has
// ever produced one of these nine strings for an email, so adding them to a
// survivor would have invented a vocabulary rather than preserved one. Adding
// any of them for real is a migration + a product decision, not a rename.

// ============================================
// VIDEO TYPES
// ============================================

// TOMBSTONE (orphan burn-down, lane H5, 2026-08-28): VIDEO_TYPES and VideoType
// are DELETED — the THIRD video-type vocabulary in the tree, and the only one
// with no writer, no reader and no constraint behind it. Neither name had a
// reference anywhere (verified comment-stripped over the whole export corpus).
// It is the sibling of the VIDEO_STATUSES deletion recorded a few lines above,
// and the same §6 ruling applies: two spellings of one fact are a defect, not a
// style choice.
//
// AND IT WAS WORSE THAN UNUSED. Of its six words only `agent_intro` is a value
// the database accepts. The live CHECK ai_video_projects_video_type_check
// admits seventeen: agent_intro, avatar_explainer, coming_soon, education,
// home_anniversary, just_listed, just_sold, listing_promo, listing_tour,
// market_update, memory_video, open_house_promo, pre_appointment,
// presentation_chapter, social_reel, testimonial, welcome
// (generated cache: scripts/check-vocabularies.ts:241). So a caller that had
// adopted this list would have sent `full_tour`, `social_snippet`,
// `instagram_story`, `reel` or `drone_highlight` into an insert the database
// refuses outright — the PGRST/23514 shape CLAUDE.md §3 records, where the row
// does not land at all.
//
// SURVIVORS:
//   · THE VOCABULARY → the live CHECK above, cached in
//     scripts/check-vocabularies.ts and regenerated, never hand-edited.
//   · ITS ENFORCEMENT AT THE EDGE → app/api/video/projects/route.ts:13, which
//     validates untrusted input against that same seventeen-value list before
//     the insert so a bad request is a 400 and not a 500.
//   · FORMAT/ASPECT (what `instagram_story`, `reel` and `social_snippet` were
//     really reaching for) → the Director's format selection and
//     lib/kernel/video-coordination.ts PROMOTABLE_VIDEO_KINDS for what may be
//     promoted, which is a DIFFERENT question from what kind of video it is and
//     is deliberately kept separate (see manager-registry
//     `anniversary_video_delivery` for what happened the last time those two
//     were conflated).
// NOTHING WAS MERGED: the five non-admitted words name shapes this product does
// not model as a video_type, and adding one is a migration plus a product
// decision, not a rename.

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

// TOMBSTONE (§1.3 + §6, 2026-08-31, lane M4): `CAMPAIGN_TYPES`/`CampaignType`
// and `CAMPAIGN_STATUSES`/`CampaignStatus` deleted — scaffolding vocabularies
// that never became canonical. No file imported any of the four, and each live
// campaign domain deliberately carries its OWN CHECK-backed or module-owned
// vocabulary, none of which matches what stood here:
//   · ISA campaigns    ai_isa_campaigns.campaign_type (buyer_match, divorce,
//                      foreclosure, fsbo, ghost_recovery, search_intent,
//                      social_intent) + status (active, archived, completed,
//                      draft, paused) — scripts/check-vocabularies.ts
//   · email campaigns  email_campaigns.campaign_format (drip, event_triggered,
//                      one_off, segmented, transactional) + its own status list
//   · ad campaigns     app/actions/marketing-studio.ts:CampaignStatus (draft,
//                      pending_approval, approved, live, paused, ended)
// An ISA prospecting campaign, an email drip and a paid ad flight are different
// business processes; one fused "campaign" vocabulary was the defect the
// per-domain CHECKs already fixed. Values differ BY DECISION — not equalized.

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

// TOMBSTONE (§1.3, 2026-08-31, lane M4): `SUCCESS_MESSAGES` deleted —
// scaffolding that never became canonical. Zero importers ever; unlike its
// sibling ERROR_MESSAGES above (live: lib/errors/index.ts consumes it as
// default messages for the error classes), no surface ever wanted a generic
// "Successfully created." — live success copy is written per-surface, inline
// at each toast/return site, naming what actually happened ("Synced 3
// documents", not "Successfully synced."). That per-surface specificity is a
// decision, not drift; a shared table of shrugs is not the missing half of
// anything.

// ============================================
// LIMITS & PAGINATION
// ============================================

// TOMBSTONE (§1.3, 2026-08-31, lane M4): `PAGINATION` and the remainder of
// `CONTENT_LIMITS` deleted — v0 scaffolding, zero importers ever, and NOT the
// canonical source of any live number. Adjudicated against the live
// per-module counterparts rather than assumed:
//   · page sizes are PER-SURFACE DECISIONS with different reasons:
//     lib/crm/import-pull.ts PAGE_SIZE=100 (provider pull batch),
//     lib/external/arcgis-permits.ts ARCGIS_PAGE_SIZE=1000 (provider max),
//     app/notifications/page.tsx PAGE_SIZE=20 (a screenful). Repointing a CRM
//     batch and a notification list onto one DEFAULT_PAGE_SIZE would fuse
//     different decisions to make a barrel look adopted.
//   · CONTENT_LIMITS' only live family — the social-post character caps —
//     was already merged out to SOCIAL_POST_CHAR_LIMITS below (the 2026-08-29
//     merge note there). The leftover email/description/hashtag caps
//     (EMAIL_SUBJECT_MAX 150 etc.) are enforced by NO validator, zod schema
//     or writer anywhere; they were invented numbers awaiting a consumer that
//     eleven months of product never wanted. Values recorded here so none is
//     silently lost: EMAIL_SUBJECT_MAX 150, EMAIL_BODY_MAX 10000,
//     DESCRIPTION_SHORT/STANDARD/EXTENDED 500/2000/5000, HASHTAGS_MAX 30,
//     HASHTAG_LENGTH_MAX 50.

/**
 * PLATFORM CHARACTER LIMITS — keyed by the platform string the callers already
 * carry, which is the shape the one live consumer needs.
 *
 * MERGED (§1.1 / §6, 2026-08-29). Two copies of this stood in the tree:
 *   1. `CONTENT_LIMITS.SOCIAL_POST_*` above — flat SCREAMING_CASE keys, exported,
 *      and imported by nobody. It could not be used by the live caller even in
 *      principle: that caller has `params.platform` as a string and needs a
 *      lookup, not four constants it would have to switch over by hand.
 *   2. `CHAR_LIMITS` at app/actions/social/generate-social-post.ts:141 — private,
 *      LIVE (it is the number written into the model prompt), and the only one
 *      with a `tiktok` arm at all.
 * Neither was a superset, so the merge takes from both: the live map's shape and
 * its tiktok arm, this module's facebook figure (63206 — Facebook's actual post
 * ceiling; the live copy carried a rounded 63000), and a single home so a fifth
 * platform is added in one place instead of two.
 *
 * The default belongs HERE too. The live caller wrote `?? 2200`, an unlabelled
 * repeat of the instagram figure. The VALUE is kept exactly as it was — this
 * change moves no live number, and picking a different bound would need evidence
 * about platforms nobody has mapped — but it is named now, so the next reader
 * can see it is a chosen fallback and not a copy of the line above it.
 */
export const SOCIAL_POST_CHAR_LIMITS: Readonly<Record<string, number>> = {
  facebook:  63206,
  instagram: 2200,
  linkedin:  3000,
  twitter:   280,
  tiktok:    2200,
}

/** Ceiling for a platform not in the map above. Unchanged from the live caller's `?? 2200`. */
export const SOCIAL_POST_CHAR_LIMIT_DEFAULT = 2200

// TOMBSTONE (lane BI, 2026-08-26): the hand-kept FILE_LIMITS literal that stood
// here is DELETED. The name survives — it is RE-EXPORTED from its survivor below
// — because §1 forbids deleting to move a number, and because the capability was
// wanted; what is deleted is the three invented numbers.
//
// SURVIVOR: lib/storage/file-limits.ts, where FILE_LIMITS is DERIVED from the
// live bucket configuration cached in lib/storage/bucket-limits.ts, so it cannot
// silently disagree with the platform again.
//
// WHAT IT SAID AND WHY EACH LINE WAS WRONG (all three now move DOWN):
//   IMAGE_MAX_SIZE    10 MB → 5 MB   the brokerage-assets bucket enforces
//                                     5,242,880 bytes and image types only.
//   VIDEO_MAX_SIZE   500 MB → 50 MB  listing-media enforces 52,428,800. 500 MB
//                                     was reachable by no path at all: Supabase
//                                     refuses it at the bucket, and anything
//                                     routed through a Next.js route handler or
//                                     Server Action is refused 110× sooner by
//                                     Vercel's 4.5 MB function body cap.
//   DOCUMENT_MAX_SIZE 50 MB → 10 MB  agent-documents enforces 10,485,760.
//
// A class-keyed constant is the WEAKER question, which is why it is no longer
// the only one on offer: the number that decides a real upload is
// checkUpload({ bucket, transport, bytes, contentType }) in the survivor, which
// takes the smaller of the bucket's limit and what the transport can carry.
export { FILE_LIMITS } from "@/lib/storage/file-limits"

// ============================================
// TIME CONSTANTS
// ============================================

// TOMBSTONE (§1.3, 2026-08-31, lane M4): `CACHE_TTL` (SHORT 5m / MEDIUM 30m /
// LONG 2h / VERY_LONG 24h) and `TIME` (its only reader — ms-per-unit
// scaffolding) deleted. Zero importers ever; NOT the canonical source of any
// live TTL. Every live cache owns its number next to its cache, with local
// semantics no abstract SHORT/MEDIUM can carry:
//   lib/compliance-rules/state-fair-housing.ts CACHE_TTL_MS (5m),
//   lib/ai/pipeline.ts PERSONA_CACHE_TTL_MS (5m) + BRAND_VOICE_CACHE_TTL_MS
//   (10m — deliberately longer, brand voice changes rarely),
//   lib/auth/isa-actor.ts CACHE_TTL_MS (5m),
//   lib/managers/accuracy-gate.ts VERDICT_TTL_MS (5m — "accuracy moves at
//   closing speed"), lib/platform/platform-controls.ts HALT_TTL_MS (20s) and
//   lib/managers/autonomy-gate.ts TENANT_HALT_TTL_MS (20s — a halt must be
//   seen fast). Those differing values are decisions; a barrel of four named
//   buckets nobody adopted was not the canon, and repointing a 20-second halt
//   onto "SHORT" would have erased the reasoning that picked 20 seconds.

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


