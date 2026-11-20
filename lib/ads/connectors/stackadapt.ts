/**
 * lib/ads/connectors/stackadapt.ts
 *
 * StackAdapt in the ONE ad-connector contract (wave 146, lane 146E — owner ruling 8: the second TV connection).
 * Spells NO StackAdapt GraphQL of its own (§6): every call delegates to lib/providers/stackadapt-ads.ts
 * (`server-only`, imported DYNAMICALLY — the registry is reached from plain tsx proofs).
 *
 * THE TV GATE IS THE SAME ONE: publish runs lib/ads/ctv-campaign.ts ensureCtvBroadcastReady before StackAdapt is
 * asked. Only the CTV campaign type is built; StackAdapt's NATIVE / DISPLAY / VIDEO / AUDIO / DOOH are not TV and
 * are not offered here (STACKADAPT_DECLARATION.nonTvFormats).
 *
 * AUDIENCES: StackAdapt documents a CRM segment of hashed identifiers (createCrmSegmentWithPii), so the
 * Customer-Match half of syncAudience (lib/kernel/ads.ts — consent, fair-housing, persona and source-rule gates all
 * run BEFORE a connector is reached) can push to it. Performance is ASYNC (campaignDelivery answers Progress while it
 * computes), so the connector returns the shared pending marker and the ingest asks again next pass.
 */
import type { AdConnector, ConnectorCredential, PerformanceFetchResult, PerformanceQuery, PublishArgs, PublishResult, AudiencePushArgs, AudienceSyncResult, ProviderStatusQuery, ProviderStatusResult } from "./types"
import { deriveMetrics } from "./types"

export const STACKADAPT_PLATFORM = "stackadapt"

function toStackadaptCredential(cred: ConnectorCredential) {
  return { apiKey: cred.accessToken, accountId: cred.accountId, config: cred.config, brokerageId: cred.brokerageId ?? null }
}

export const stackadaptConnector: AdConnector = {
  platform: STACKADAPT_PLATFORM,

  async publishCampaign(args: PublishArgs): Promise<PublishResult> {
    const campaignId = String(args.structure.campaign_id ?? "")
    if (!campaignId) return { ok: false, error: "structure.campaign_id required — a StackAdapt publish reads the staged ad_campaigns row" }
    if (!args.cred.brokerageId) return { ok: false, error: "stackadapt: the credential names no tenant — the broadcast gate cannot run, so nothing is published" }
    const { ensureCtvBroadcastReady } = await import("@/lib/ads/ctv-campaign")
    const gate = await ensureCtvBroadcastReady({ campaignId, brokerageId: args.cred.brokerageId })
    if (!gate.ok) return { ok: false, error: `stackadapt: not published — ${gate.reason}` }
    const { launchStackadaptCampaign } = await import("@/lib/providers/stackadapt-ads")
    const r = await launchStackadaptCampaign(campaignId)
    return r.dispatched && r.stackadaptCampaignId
      ? { ok: true, externalCampaignId: r.stackadaptCampaignId }
      : { ok: false, error: r.reason }
  },

  async pushCustomAudience(args: AudiencePushArgs): Promise<AudienceSyncResult> {
    const { pushStackadaptCrmSegment } = await import("@/lib/providers/stackadapt-ads")
    return pushStackadaptCrmSegment(toStackadaptCredential(args.cred), { name: args.audienceName, externalSegmentId: args.externalAudienceId, members: args.members })
  },

  async createLookalike() {
    return { ok: false, recordsSynced: 0, recordsRejected: 0, error: "stackadapt: lookalike expansion is a CAMPAIGN audience setting (CampaignAudienceInput.lookalikeExpansion), not a standalone seeded audience — not offered on the TV lane" }
  },

  async fetchPerformance(args: PerformanceQuery): Promise<PerformanceFetchResult> {
    const { fetchStackadaptCampaignDelivery } = await import("@/lib/providers/stackadapt-ads")
    const r = await fetchStackadaptCampaignDelivery(toStackadaptCredential(args.cred), args.campaignExternalId, args.sinceIso)
    if (r.pending) return { pending: true, providerState: { ...(args.providerState ?? {}), stackadapt_delivery_pending_at: new Date().toISOString() } }
    const t = r.totals
    const leads = 0
    return {
      spend: t.spend, impressions: t.impressions, clicks: t.clicks, leads, conversions: t.conversions, revenue: t.conversionRevenue,
      ...deriveMetrics({ spend: t.spend, impressions: t.impressions, clicks: t.clicks, leads }),
    }
  },

  async fetchStatus(args: ProviderStatusQuery): Promise<ProviderStatusResult> {
    const { readStackadaptCampaignStatus } = await import("@/lib/providers/stackadapt-ads")
    const r = await readStackadaptCampaignStatus(toStackadaptCredential(args.cred), args.campaignExternalId)
    if (!r.ok) return { ok: false, reason: r.reason }
    const state = (r.state ?? "unknown").toLowerCase()
    return { ok: true, state, review: state === "pending" || state === "rejected" ? state : null }
  },
}
