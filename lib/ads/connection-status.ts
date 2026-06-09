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

// The platform value an ad campaign uses → the platform_credentials row the
// connector loads (instagram ads run through the Meta/facebook credential).
export function adCredentialPlatform(campaignPlatform: string): string {
  return campaignPlatform === "instagram" ? "facebook" : campaignPlatform
}

export interface AdConnection { platform: string; connected: boolean; accountId: string | null }

/** Report connection status for the ad platforms (facebook, google). */
export async function getAdConnections(
  brokerageId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<AdConnection[]> {
  const supabase = client ?? createServiceClient()
  const platforms = ["facebook", "google"]
  const { data } = await supabase
    .from("platform_credentials")
    .select("platform, account_id, is_active")
    .eq("brokerage_id", brokerageId)
    .in("platform", platforms)
    .eq("is_active", true)
  const rows = (data ?? []) as Array<{ platform: string; account_id: string | null }>
  return platforms.map((p) => {
    const row = rows.find((r) => r.platform === p)
    return { platform: p, connected: !!row, accountId: row?.account_id ?? null }
  })
}

/** Launch precheck: is the campaign's ad platform connected (with an ad account)? */
export async function isAdPlatformConnected(
  brokerageId: string, campaignPlatform: string, client?: ReturnType<typeof createServiceClient>,
): Promise<{ connected: boolean; reason?: string }> {
  const platform = adCredentialPlatform(campaignPlatform)
  const conns = await getAdConnections(brokerageId, client)
  const conn = conns.find((c) => c.platform === platform)
  if (!conn?.connected) return { connected: false, reason: `${platform} ad account not connected — connect it in Settings → Connections` }
  if (!conn.accountId) return { connected: false, reason: `${platform} connected but no ad account selected` }
  return { connected: true }
}
