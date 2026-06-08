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

const CONNECTORS: Record<string, AdConnector> = {
  facebook:  metaConnector,
  instagram: metaConnector,
  google:    googleConnector,
}

export function getConnector(platform: string): AdConnector | null {
  return CONNECTORS[platform] ?? null
}

/** Load the brokerage's stored credential for a platform from platform_credentials. */
export async function loadConnectorCredential(
  brokerageId: string, platform: string, client?: ReturnType<typeof createServiceClient>,
): Promise<ConnectorCredential | null> {
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
