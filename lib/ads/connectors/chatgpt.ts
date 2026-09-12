/**
 * lib/ads/connectors/chatgpt.ts
 *
 * The CHATGPT ADS connector (OpenAI Advertiser API) in the one ad-connector
 * contract, so the Ads Manager's loop — launch → ingest performance → judge on
 * real outcomes → scale/pause — runs for `chatgpt` exactly as for Meta, Google
 * and streaming TV.
 *
 * This file spells NO OpenAI Ads HTTP of its own (§6): publish delegates to
 * lib/providers/openai-ads.ts dispatchChatgptCampaign (the documented chain
 * account → geo lookup → upload → campaign → ad group → ad → activate);
 * performance to fetchOpenaiCampaignInsights. The provider is `server-only`, so
 * it is imported DYNAMICALLY (the registry is reached from plain tsx proofs —
 * lib/ads/connectors/vibe-ctv.ts records the same reason).
 *
 * HONESTY: OpenAI Ads custom audiences exist (Audiences API) but this lane
 * targets geography + intent context only (Fair Housing); the two audience
 * methods say so rather than returning a fabricated ok. Leads are not in the
 * delivery insights (conversions are a separate, gated endpoint), so `leads`
 * is 0 here and the landing page's utm_source=chatgpt attribution is where a
 * ChatGPT lead is counted.
 */
import type { AdConnector, ConnectorCredential, PerformanceFetchResult, PerformanceQuery, PublishArgs, PublishResult } from "./types"
import { deriveMetrics } from "./types"

export const CHATGPT_PLATFORM = "chatgpt"

function toOpenaiCredential(cred: ConnectorCredential) {
  return { apiKey: cred.accessToken, accountId: cred.accountId, config: cred.config }
}

export const chatgptConnector: AdConnector = {
  platform: CHATGPT_PLATFORM,

  async publishCampaign(args: PublishArgs): Promise<PublishResult> {
    const campaignId = String(args.structure.campaign_id ?? "")
    if (!campaignId) return { ok: false, error: "structure.campaign_id required — a ChatGPT publish reads the staged ad_campaigns row" }
    const { dispatchChatgptCampaign } = await import("@/lib/providers/openai-ads")
    const r = await dispatchChatgptCampaign(campaignId)
    return r.dispatched && r.openaiCampaignId
      ? { ok: true, externalCampaignId: r.openaiCampaignId }
      : { ok: false, error: r.reason }
  },

  async pushCustomAudience() {
    return { ok: false, recordsSynced: 0, recordsRejected: 0, error: "chatgpt: CRM audiences are not pushed — the lane targets geography + intent context only (Fair Housing)" }
  },

  async createLookalike() {
    return { ok: false, recordsSynced: 0, recordsRejected: 0, error: "chatgpt: lookalike audiences are not offered on the ChatGPT lane" }
  },

  async fetchPerformance(args: PerformanceQuery): Promise<PerformanceFetchResult> {
    const { fetchOpenaiCampaignInsights } = await import("@/lib/providers/openai-ads")
    const t = await fetchOpenaiCampaignInsights(toOpenaiCredential(args.cred), args.campaignExternalId, args.sinceIso)
    const leads = 0
    return {
      spend: t.spend, impressions: t.impressions, clicks: t.clicks, leads, conversions: 0, revenue: 0,
      ...deriveMetrics({ spend: t.spend, impressions: t.impressions, clicks: t.clicks, leads }),
    }
  },
}
