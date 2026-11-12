/**
 * lib/ads/connectors/groundtruth.ts
 *
 * GroundTruth in the ONE ad-connector contract (wave 146, lane 146E — owner ruling 8: "groundtruth and stackadapt are
 * 2 tv connections"), so the Ads Manager's loop — launch → ingest performance → judge → scale/pause — runs for
 * `groundtruth` exactly as for Meta, Google, Vibe and ChatGPT. This file spells NO GroundTruth HTTP of its own (§6):
 * every call delegates to lib/providers/groundtruth-ads.ts, which is `server-only`, so it is imported DYNAMICALLY
 * (the registry is reached from plain tsx proofs — lib/ads/connectors/vibe-ctv.ts records the same reason).
 *
 * THE TV GATE IS THE SAME ONE: publish runs lib/ads/ctv-campaign.ts ensureCtvBroadcastReady (an approved public
 * video, a READY TV master, an approved topic when the spot has one) BEFORE the provider is asked — no tenant on the
 * credential = no publish (fail closed). Only the CTV format is built; GroundTruth's other formats are not TV and are
 * not offered here (GROUNDTRUTH_DECLARATION.nonTvFormats).
 *
 * HONESTY: the audience methods refuse — GroundTruth publishes no first-party audience upload (declared "unknown"),
 * and a lookalike seeded from OUR audience is not documented either.
 */
import type { AdConnector, ConnectorCredential, PerformanceFetchResult, PerformanceQuery, PublishArgs, PublishResult, ProviderStatusQuery, ProviderStatusResult } from "./types"
import { deriveMetrics } from "./types"

export const GROUNDTRUTH_PLATFORM = "groundtruth"

function toGroundtruthCredential(cred: ConnectorCredential) {
  return {
    apiKey: cred.accessToken,
    apiSecret: (cred.config.api_secret as string | undefined) ?? null,
    accountId: cred.accountId,
    config: cred.config,
    brokerageId: cred.brokerageId ?? null,
  }
}

export const groundtruthConnector: AdConnector = {
  platform: GROUNDTRUTH_PLATFORM,

  async publishCampaign(args: PublishArgs): Promise<PublishResult> {
    const campaignId = String(args.structure.campaign_id ?? "")
    if (!campaignId) return { ok: false, error: "structure.campaign_id required — a GroundTruth publish reads the staged ad_campaigns row" }
    if (!args.cred.brokerageId) return { ok: false, error: "groundtruth: the credential names no tenant — the broadcast gate cannot run, so nothing is published" }
    const { ensureCtvBroadcastReady } = await import("@/lib/ads/ctv-campaign")
    const gate = await ensureCtvBroadcastReady({ campaignId, brokerageId: args.cred.brokerageId })
    if (!gate.ok) return { ok: false, error: `groundtruth: not published — ${gate.reason}` }
    const { launchGroundtruthCampaign } = await import("@/lib/providers/groundtruth-ads")
    const r = await launchGroundtruthCampaign(campaignId)
    return r.dispatched && r.groundtruthCampaignId
      ? { ok: true, externalCampaignId: r.groundtruthCampaignId }
      : { ok: false, error: r.reason }
  },

  async pushCustomAudience() {
    const { GROUNDTRUTH_DECLARATION } = await import("@/lib/providers/groundtruth-ads")
    return { ok: false, recordsSynced: 0, recordsRejected: 0, error: `groundtruth: no first-party audience upload is published — ${GROUNDTRUTH_DECLARATION.capabilities.audience_sync.evidence}` }
  },

  async createLookalike() {
    return { ok: false, recordsSynced: 0, recordsRejected: 0, error: "groundtruth: a lookalike seeded from this OS's audience is not documented (ad groups carry lookalike_audience_scale over GroundTruth's own audiences only)" }
  },

  async fetchPerformance(args: PerformanceQuery): Promise<PerformanceFetchResult> {
    const { fetchGroundtruthCampaignTotals } = await import("@/lib/providers/groundtruth-ads")
    const t = await fetchGroundtruthCampaignTotals(toGroundtruthCredential(args.cred), args.campaignExternalId, args.sinceIso)
    // A TV ad has no lead form: leads are counted where the viewer lands (utm attribution), never invented here.
    const leads = 0
    return {
      spend: t.spend, impressions: t.impressions, clicks: t.clicks, leads, conversions: t.conversions, revenue: 0,
      ...deriveMetrics({ spend: t.spend, impressions: t.impressions, clicks: t.clicks, leads }),
    }
  },

  async fetchStatus(args: ProviderStatusQuery): Promise<ProviderStatusResult> {
    const { readGroundtruthCampaignStatus } = await import("@/lib/providers/groundtruth-ads")
    const r = await readGroundtruthCampaignStatus(toGroundtruthCredential(args.cred), args.campaignExternalId)
    return r.ok ? { ok: true, state: r.status, review: null } : { ok: false, reason: r.reason }
  },
}
