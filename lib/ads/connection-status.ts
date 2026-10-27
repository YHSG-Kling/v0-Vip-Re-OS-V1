/**
 * lib/ads/connection-status.ts
 *
 * Wave 43 — ad-account connection status + launch precheck. The connector layer
 * loads credentials from platform_credentials (written by the OAuth flow); this
 * reports which ad platforms a brokerage has connected, and gates campaign launch
 * so the Ads Manager never tries to spend on a platform with no connected account
 * (business rule #9: provider account connection required before launch).
 */
import { createServiceClient } from "@/lib/supabase/service"
import { PROVIDER_CONNECTED_AD_PLATFORMS } from "@/lib/integrations/ad-campaign-vocabulary"

// The platform value an ad campaign uses → the platform_credentials row the
// connector loads (instagram ads run through the Meta/facebook credential).
//
// Wave 145 (lane 145D, owner ruling 13 — "ads = meta, google ads"): Google Ads' credential is 'google_ads', never the
// bare 'google'. The bare name was the campaign vocabulary leaking into the credential column (CLAUDE.md §6): the live
// platform_credentials CHECK never admitted 'google', so the OAuth callback's write was refused and Google Ads could
// never be connected (m862 admits 'google_ads'; lib/providers/channel-provider-matrix.ts AD_PLATFORMS.google_ads).
// THE ONE mapping — lib/ads/connectors/registry.ts and lib/ads/launch-assembler.ts read it, never a copy.
const AD_CREDENTIAL_PLATFORM: Readonly<Record<string, string>> = Object.freeze({ instagram: "facebook", google: "google_ads" })
export function adCredentialPlatform(campaignPlatform: string): string {
  return AD_CREDENTIAL_PLATFORM[campaignPlatform] ?? campaignPlatform
}

export interface AdConnection { platform: string; connected: boolean; accountId: string | null }

/** Report connection status for the ad platforms (facebook, google) — keyed by CAMPAIGN platform, read by credential name. */
export async function getAdConnections(
  brokerageId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<AdConnection[]> {
  const supabase = client ?? createServiceClient()
  const platforms = ["facebook", "google"]
  // supabase-js RESOLVES a refusal (CLAUDE.md §3): a refused read is logged and reads as not connected (fail closed), never in silence.
  const { data, error } = await supabase
    .from("platform_credentials")
    .select("platform, account_id, is_active")
    .eq("brokerage_id", brokerageId)
    .in("platform", platforms.map(adCredentialPlatform))
    .eq("is_active", true)
  if (error) console.error("[ads] ad-account connection read refused:", error.message)
  const rows = (data ?? []) as Array<{ platform: string; account_id: string | null }>
  return platforms.map((p) => {
    const row = rows.find((r) => r.platform === adCredentialPlatform(p))
    return { platform: p, connected: !!row, accountId: row?.account_id ?? null }
  })
}

/** Launch precheck: is the campaign's ad platform connected (with an ad account)? */
export async function isAdPlatformConnected(
  brokerageId: string, campaignPlatform: string, client?: ReturnType<typeof createServiceClient>,
): Promise<{ connected: boolean; reason?: string }> {
  // Streaming TV is connected through the Connection OS provider 'vibe'
  // (PROVIDER_CONNECTED_AD_PLATFORMS), never a platform_credentials ad account —
  // asking that table for 'vibe_ctv' always answered "not connected".
  const provider = (PROVIDER_CONNECTED_AD_PLATFORMS as Record<string, string | undefined>)[campaignPlatform]
  if (provider === "vibe") {
    const { resolveVibeCredential } = await import("@/lib/providers/vibe")
    const r = await resolveVibeCredential(brokerageId)
    return r.status === "connected" ? { connected: true } : { connected: false, reason: `${r.reason} — connect Vibe in Settings → Connections` }
  }
  if (provider === "openai_ads") {
    const { resolveOpenaiAdsCredential } = await import("@/lib/providers/openai-ads")
    const r = await resolveOpenaiAdsCredential(brokerageId)
    return r.status === "connected" ? { connected: true } : { connected: false, reason: `${r.reason} — add the Ads API key (ads.openai.com → Settings) in Settings → Connections` }
  }
  if (provider) return { connected: false, reason: `${campaignPlatform} is connected through provider '${provider}', which this precheck does not resolve yet` }
  const platform = adCredentialPlatform(campaignPlatform)
  const conns = await getAdConnections(brokerageId, client)
  const conn = conns.find((c) => c.platform === platform)
  if (!conn?.connected) return { connected: false, reason: `${platform} ad account not connected — connect it in Settings → Connections` }
  if (!conn.accountId) return { connected: false, reason: `${platform} connected but no ad account selected` }
  return { connected: true }
}
