// lib/providers/vibe.ts
// Vibe.co (self-serve streaming-TV / CTV ads) — the CONNECTOR SLOT for the
// streaming-TV ad lane.
//
// HONESTY CONTRACT (matches the platform's "no simulated sends" rule — see the
// e-sign honest-refusal precedent in lib/kernel/manager-registry.ts):
//
//   * Vibe.co does not publish an open, documented public API surface we can
//     code against today. NOTHING in this module fabricates an endpoint
//     contract, and dispatchCtvCampaign NEVER reports a launch that did not
//     happen. Campaigns stay status='draft' until a human confirms the launch
//     on vibe.co and presses "Mark as launched" in the Ads Manager.
//
//   * The credential slot is live TODAY: a brokerage can store a Vibe
//     credential as integration_credentials provider_name='vibe' (or any of
//     the other credential tables the unified resolver reads). When the vendor
//     contract / API access is in hand, ONLY the dispatch body below changes —
//     every caller already handles {dispatched:false, reason}.
//
//   * Guardian note: 'vibe' has no public GET-probeable health endpoint, so it
//     is intentionally absent from PROBE_SPECS (lib/agentic-os/connector-probe.ts)
//     — same exemption class as Exa/BatchData (POST-only / no documented
//     liveness read). Credential presence is the only honest signal.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveConnection } from "@/lib/integrations/connection-manager"

export const VIBE_PROVIDER = "vibe"

/** Where the launch package deep-links. No fabricated deep-link params — the
 *  campaign builder URL scheme is not documented, so we land on the platform. */
export const VIBE_HOME_URL = "https://vibe.co"

/**
 * Is a Vibe credential connected for this brokerage?
 * Mirrors how other user-connected providers resolve: the unified
 * connection-manager resolver reads integration_credentials
 * (provider_name='vibe') plus the platform_credentials / agent_api_credentials
 * stores under the same canonical name. Never throws.
 */
export async function isVibeConfigured(brokerageId: string): Promise<boolean> {
  const conn = await resolveConnection({ brokerageId, provider: VIBE_PROVIDER }).catch(() => null)
  return conn !== null
}

export interface CtvDispatchResult {
  /** true only after a REAL provider-confirmed launch — never today. */
  dispatched: boolean
  reason: string
}

/**
 * Attempt API dispatch of a staged CTV campaign to Vibe.
 *
 * TODAY this always returns {dispatched:false} with an honest reason:
 *   - 'vibe_not_connected — campaign staged as launch package' when no
 *     credential exists (the launch package + vibe.co deep link is the path);
 *   - 'vibe_api_dispatch_pending_vendor_contract' when a credential IS
 *     connected: Vibe's API is not a documented open surface, so the real
 *     dispatch call lands here the day the vendor contract / API access is in
 *     hand. Until then we refuse to simulate a launch.
 *
 * The campaign row is never mutated here — status 'draft' stays until a human
 * marks it launched (markCtvCampaignLaunchedAction).
 */
export async function dispatchCtvCampaign(campaignId: string): Promise<CtvDispatchResult> {
  const supabase = createServiceClient()

  const { data: campaign, error } = await supabase
    .from("ad_campaigns")
    .select("id, brokerage_id, platform, status")
    .eq("id", campaignId)
    .maybeSingle()
  if (error) return { dispatched: false, reason: `campaign lookup failed: ${error.message}` }
  if (!campaign) return { dispatched: false, reason: "campaign not found" }
  if (campaign.platform !== "vibe_ctv") {
    return { dispatched: false, reason: `campaign platform is '${campaign.platform}', not 'vibe_ctv'` }
  }

  const configured = await isVibeConfigured(campaign.brokerage_id as string)
  if (!configured) {
    return { dispatched: false, reason: "vibe_not_connected — campaign staged as launch package" }
  }

  // Credential present, but no documented Vibe API contract to call yet.
  // When vendor API access exists, the real create-campaign call replaces this
  // return — and dispatched:true is set ONLY from a provider-confirmed response.
  return { dispatched: false, reason: "vibe_api_dispatch_pending_vendor_contract" }
}
