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
  // "chatgpt" — ChatGPT Ads (owner, 2026-09-06: "ads are now available with
  // chatgpt"). m607 widened the live CHECK. Connected through the OpenAI
  // Advertiser API key (provider 'openai_ads', lib/providers/openai-ads.ts).
  "chatgpt",
] as const
// TOMBSTONE (§1.3, 2026-08-31, lane M4): derived type `AdCampaignPlatform`
// deleted — never named by any consumer (validators call the type-guard /
// membership check on AD_CAMPAIGN_PLATFORMS, the live const). Re-derive when
// a typed consumer arrives.

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
 * (via meta); linkedin likewise. google/tiktok have no ads connection in the
 * Connection OS, so the workspace must not render them as merely
 * "disconnected".
 */
export const CONNECTABLE_AD_PLATFORMS = ["facebook", "instagram", "linkedin"] as const

/**
 * Ad platforms connected through a PROVIDER credential in the Connection OS
 * rather than an ad-account row: the campaign platform → the provider name the
 * resolver (lib/integrations/connection-manager.ts) is asked for. Streaming TV
 * runs on the brokerage's Vibe client credentials (lib/providers/vibe.ts).
 * Neither of the two lists above nor below may name these — a platform is in
 * exactly one class (§6).
 */
export const PROVIDER_CONNECTED_AD_PLATFORMS = { vibe_ctv: "vibe", chatgpt: "openai_ads" } as const

/**
 * Ad platforms a campaign may name that have NO account connection in the
 * Connection OS. A campaign can be created for these and cannot be launched from
 * here — surfaced honestly rather than shown as a disconnected account.
 * (chatgpt left this list 2026-09-07: the OpenAI Advertiser API exists and the
 * lane dispatches through it — PROVIDER_CONNECTED_AD_PLATFORMS.)
 */
export const AD_PLATFORMS_WITHOUT_CONNECTIONS = ["google", "tiktok"] as const

export function isConnectableAdPlatform(v: string | null | undefined): boolean {
  return !!v && (CONNECTABLE_AD_PLATFORMS as readonly string[]).includes(v)
}

/**
 * ChatGPT Ads (OpenAI Ads Manager) — the client-safe facts the lane UI needs.
 * The composer lib/ads/chatgpt-campaign.ts is server-side (it reaches the
 * service client); a "use client" lane may import only from here.
 */
export const CHATGPT_ADS_MANAGER_URL = "https://ads.openai.com"
export const CHATGPT_MIN_DAILY_BUDGET_USD = 25
export const CHATGPT_OBJECTIVES = ["reach", "clicks", "conversions"] as const
export type ChatgptObjective = (typeof CHATGPT_OBJECTIVES)[number]
