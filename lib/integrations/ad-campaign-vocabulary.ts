// lib/integrations/ad-campaign-vocabulary.ts
// ─────────────────────────────────────────────────────────────────────────────
// ad_campaigns vocabulary. This is CAMPAIGN vocabulary, not credential
// vocabulary — the two were briefly in one module of mine and that was part of
// the confusion: platform_credentials.platform (who we hold a credential for)
// and ad_campaigns.platform (where a campaign runs) are different columns with
// different vocabularies and different owners.
//
// The credential side is NOT declared here or anywhere else in this folder. It
// is owned by:
//   lib/connections/scope.ts        CONNECTOR_PROVIDERS — what a scope may connect
//   lib/providers/tenancy-matrix.ts PROVIDER_TENANCY    — who owns the vendor
// Those are the two files a new vendor is decided in. Nothing here re-declares
// them.

/** ad_campaigns.platform — every platform a campaign may target. */
export const AD_CAMPAIGN_PLATFORMS = [
  "facebook", "instagram", "google", "linkedin", "tiktok", "vibe_ctv",
] as const
export type AdCampaignPlatform = (typeof AD_CAMPAIGN_PLATFORMS)[number]

/** ad_campaigns.status — the full ladder. */
export const AD_CAMPAIGN_STATUSES = [
  "draft", "pending_review", "approved", "launching", "live", "paused", "ended", "failed",
] as const
export type AdCampaignStatus = (typeof AD_CAMPAIGN_STATUSES)[number]

/**
 * Campaigns that are spending, or about to. Two manager modules asked for
 * `["live", "active"]` — 'active' is not a value this column admits, so it was
 * dead weight riding along with a real one. 'launching' is included because a
 * campaign mid-launch is committed spend the managers must see.
 */
export const AD_CAMPAIGN_RUNNING_STATUSES = ["launching", "live"] as const satisfies readonly AdCampaignStatus[]

/**
 * Ad platforms the ads workspace may show an ACCOUNT CONNECTION for.
 *
 * Deliberately narrow, and deliberately NOT a credential allow-list: it is the
 * intersection of "a campaign can target it" and "the Connection OS actually
 * offers a connection for it". facebook + instagram are CONNECTOR_PROVIDERS.social
 * (via meta); linkedin likewise. google/tiktok/vibe_ctv have no ads connection in
 * the Connection OS, so the workspace must not render them as merely
 * "disconnected".
 */
export const CONNECTABLE_AD_PLATFORMS = ["facebook", "instagram", "linkedin"] as const

/**
 * Ad platforms a campaign may name that have NO account connection in the
 * Connection OS. A campaign can be created for these and cannot be launched from
 * here — surfaced honestly rather than shown as a disconnected account.
 */
export const AD_PLATFORMS_WITHOUT_CONNECTIONS = ["google", "tiktok", "vibe_ctv"] as const

export function isConnectableAdPlatform(v: string | null | undefined): boolean {
  return !!v && (CONNECTABLE_AD_PLATFORMS as readonly string[]).includes(v)
}
