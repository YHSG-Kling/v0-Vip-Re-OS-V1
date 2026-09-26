/**
 * lib/ads/connectors/registry.ts
 *
 * Wave 42 — resolve the right ad connector for a platform + load that platform's
 * stored credential. Adding a vendor (LinkedIn/TikTok) = one entry here. instagram
 * shares Meta's Graph API, so it maps to the Meta connector.
 */
import { createServiceClient } from "@/lib/supabase/service"
import type { AdConnector, ConnectorCredential } from "./types"
import { metaConnector } from "./meta"
import { googleConnector } from "./google"
import { vibeCtvConnector } from "./vibe-ctv"
import { chatgptConnector } from "./chatgpt"

const CONNECTORS: Record<string, AdConnector> = {
  facebook:  metaConnector,
  instagram: metaConnector,
  google:    googleConnector,
  // Streaming TV (Vibe.co). Its credential is NOT a platform_credentials row —
  // the Connection OS resolves provider 'vibe' — see loadConnectorCredential.
  vibe_ctv:  vibeCtvConnector,
  // ChatGPT Ads (OpenAI Advertiser API, developers.openai.com/ads). Its
  // credential is the Ads API key under Connection OS provider 'openai_ads' —
  // see loadConnectorCredential. (Until 2026-09-07 this read "no public API";
  // the owner linked the quickstart and ruled build.)
  chatgpt:   chatgptConnector,
}

export function getConnector(platform: string): AdConnector | null {
  return CONNECTORS[platform] ?? null
}

/** Load the brokerage's stored credential for a platform from platform_credentials. */
export async function loadConnectorCredential(
  brokerageId: string, platform: string, client?: ReturnType<typeof createServiceClient>,
): Promise<ConnectorCredential | null> {
  // Vibe is resolved by the Connection OS (integration_credentials /
  // platform_credentials / agent_api_credentials under provider 'vibe'), never
  // by the ads-only platform_credentials read below — its platform CHECK does
  // not even admit 'vibe'. One resolver (lib/providers/vibe.ts) for every caller.
  if (platform === "vibe_ctv") {
    const { resolveVibeCredential } = await import("@/lib/providers/vibe")
    const r = await resolveVibeCredential(brokerageId)
    if (r.status !== "connected") {
      if (r.status === "unreadable") console.error("[ad-connectors] vibe credential unreadable:", r.reason)
      return null
    }
    return { accessToken: r.conn.apiKey as string, accountId: r.conn.accountId, config: { ...r.conn.config, api_secret: r.conn.apiSecret } }
  }
  if (platform === "chatgpt") {
    const { resolveOpenaiAdsCredential } = await import("@/lib/providers/openai-ads")
    const r = await resolveOpenaiAdsCredential(brokerageId)
    if (r.status !== "connected") {
      if (r.status === "unreadable") console.error("[ad-connectors] openai_ads credential unreadable:", r.reason)
      return null
    }
    return { accessToken: r.conn.apiKey as string, accountId: r.conn.accountId, config: r.conn.config ?? {} }
  }
  const supabase = client ?? createServiceClient()
  // instagram auth lives under the facebook (Meta) credential.
  const lookup = platform === "instagram" ? "facebook" : platform
  const { data } = await supabase
    .from("platform_credentials")
    .select("access_token, account_id, config, is_active")
    .eq("brokerage_id", brokerageId).eq("platform", lookup).eq("is_active", true)
    .maybeSingle()
  const c = data as { access_token?: string; account_id?: string | null; config?: Record<string, unknown> | null; is_active?: boolean } | null
  if (!c?.access_token) return null
  return { accessToken: c.access_token, accountId: c.account_id ?? null, config: c.config ?? {} }
}
