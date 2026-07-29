// lib/integrations/credential-platforms.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CANONICAL platform_credentials.platform VOCABULARY.
//
// WHY THIS MODULE EXISTS. The "Add Platform Credential" form takes the platform
// as FREE TEXT ("e.g. dotloop, twilio, sendgrid") and writes it straight into a
// CHECK-constrained column. There was no shared list anywhere of what the column
// actually accepts, so:
//   · a broker who typed anything slightly off got a raw Postgres constraint
//     string back — technically not silent, but useless: it does not say which
//     platforms are valid;
//   · FIVE FINISHED integrations (Google Ads, Xero, WordPress, and the platform's
//     own QuickBooks + Zoom under their distinct m273-idiom keys) named values
//     the column did not admit, so each ran its whole flow and failed on the
//     last write. m297 added all five;
//   · the ads workspace read credentials using a DIFFERENT column's vocabulary
//     (ad_campaigns.platform), which is how 'tiktok' got in.
//
// One list, one guard, and the form now offers it.

/** Every value platform_credentials.platform admits (m297). */
export const CREDENTIAL_PLATFORMS = [
  // Transaction / forms
  "dotloop", "docusign", "skyslope", "authentisign", "formsimplicity", "brokermint",
  // Listings / MLS / IDX
  "showingtime", "mls", "zillow", "realtor_com", "idxbroker", "listhub", "mls_direct", "opcity",
  // Social (tenant-connected)
  "facebook", "instagram", "linkedin", "buffer",
  // Social (the PLATFORM's own accounts — deliberately distinct keys so a tenant
  // cascade can never resolve the company's account)
  "platform_social_facebook", "platform_social_instagram", "platform_social_linkedin",
  "platform_social_x", "platform_social_tiktok", "platform_social_youtube",
  // Media / AI
  "heygen", "google_flow", "did", "pexels",
  // Voice / telephony
  "twilio", "telnyx", "bandwidth", "sinch", "vapi", "plivo",
  "twilio_subaccount", "twilio_byo", "twilio_a2p",
  // Email
  "sendgrid", "resend", "postmark", "mailgun", "gmail", "outlook",
  // Calendar / meetings
  "google_calendar", "zoom",
  // Money
  "stripe", "plaid", "quickbooks", "xero",
  // Direct mail
  "lob",
  // CRM
  "gohighlevel", "followupboss", "lofty", "hubspot",
  // Ads + publishing
  "google", "wordpress",
  // The PLATFORM's OWN accounts, under DISTINCT keys (the m273 idiom). The
  // tenant credential cascade falls back to owner_type='platform', so reusing
  // the plain 'quickbooks' / 'zoom' keys would let a brokerage with no
  // connection of its own resolve — and bill against, or host meetings on — the
  // COMPANY's account. lib/connections/accounting-scopes.ts and
  // lib/connections/zoom.ts own these keys; never collapse them into the tenant
  // ones, which is the leak they exist to make impossible.
  "platform_quickbooks", "platform_zoom",
] as const

export type CredentialPlatform = (typeof CREDENTIAL_PLATFORMS)[number]

export function isCredentialPlatform(v: unknown): v is CredentialPlatform {
  return typeof v === "string" && (CREDENTIAL_PLATFORMS as readonly string[]).includes(v)
}

// ── Ad accounts ──────────────────────────────────────────────────────────────
//
// ad_campaigns.platform is a DIFFERENT column with a DIFFERENT vocabulary:
// (facebook | instagram | google | linkedin | tiktok | vibe_ctv). The ads
// workspace read platform_credentials using that list, which is how it came to
// ask for a 'tiktok' credential — a value platform_credentials has never
// admitted and, more to the point, that nothing in this codebase could write:
// there is no TikTok OAuth provider and no TikTok connect form.
//
// The two lists are therefore kept explicitly separate, and the gap is NAMED
// rather than hidden. "Not connected" and "cannot be connected" are different
// facts and a workspace that shows the first when it means the second is lying.

/** ad_campaigns.platform — every platform a campaign may target. */
export const AD_CAMPAIGN_PLATFORMS = [
  "facebook", "instagram", "google", "linkedin", "tiktok", "vibe_ctv",
] as const
export type AdCampaignPlatform = (typeof AD_CAMPAIGN_PLATFORMS)[number]

/**
 * Ad platforms whose account credential can actually be stored and connected —
 * every one of these has a real OAuth provider behind it (meta_ads → facebook,
 * google_ads → google, linkedin).
 */
export const CONNECTABLE_AD_PLATFORMS = [
  "facebook", "instagram", "google", "linkedin",
] as const satisfies readonly CredentialPlatform[]

/**
 * Ad platforms a campaign may name but that have NO credential path today. A
 * campaign can be created for these and can never be launched from here.
 * Surfaced honestly rather than rendered as a disconnected account.
 */
export const AD_PLATFORMS_WITHOUT_CREDENTIALS = ["tiktok", "vibe_ctv"] as const

export function isConnectableAdPlatform(v: string | null | undefined): boolean {
  return !!v && (CONNECTABLE_AD_PLATFORMS as readonly string[]).includes(v)
}

/** ad_campaigns.status — the full ladder. */
export const AD_CAMPAIGN_STATUSES = [
  "draft", "pending_review", "approved", "launching", "live", "paused", "ended", "failed",
] as const
export type AdCampaignStatus = (typeof AD_CAMPAIGN_STATUSES)[number]

/**
 * Campaigns that are spending, or about to. Two manager modules asked for
 * `["live", "active"]` — 'active' is not a value this column admits, so it was
 * dead weight riding along with a real one. Harmless in an .in(), and exactly
 * the sort of literal the next reader copies. 'launching' is included because a
 * campaign mid-launch is committed spend the managers must see.
 */
export const AD_CAMPAIGN_RUNNING_STATUSES = ["launching", "live"] as const satisfies readonly AdCampaignStatus[]
