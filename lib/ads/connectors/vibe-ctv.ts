/**
 * lib/ads/connectors/vibe-ctv.ts
 *
 * The STREAMING-TV connector (Vibe.co) in the one ad-connector contract, so the
 * Ads Manager's loop — launch → ingest performance → judge on real outcomes →
 * scale/pause — runs for `vibe_ctv` exactly as it does for Meta and Google.
 *
 * This file spells NO Vibe HTTP of its own (§6 — one vocabulary per function).
 * Every call delegates to lib/providers/vibe.ts, the survivor: publish is
 * `dispatchCtvCampaign` (advertiser → creative upload → campaign → strategy →
 * PUBLISH), performance is the async report pair
 * `requestVibeCampaignReport` / `readVibeCampaignReport`.
 *
 * Imports of the provider are DYNAMIC: lib/providers/vibe.ts is `server-only`,
 * and this registry entry is reached from plain `tsx` guard simulators that
 * load lib/ads/connectors/registry.ts (lib/ads/ad-lead-intake.ts records the
 * same reason for the same pattern).
 *
 * HONESTY: audiences on Vibe are hashed-email (HEM) syncs under an advertiser,
 * not Meta-style custom audiences; that lane is not built here, and the two
 * audience methods say so rather than returning a fabricated ok.
 */
import type { AdConnector, ConnectorCredential, PerformanceFetchResult, PerformanceQuery, PublishArgs, PublishResult } from "./types"
import { deriveMetrics } from "./types"

export const VIBE_CTV_PLATFORM = "vibe_ctv"

/** The registry credential projection carries the Vibe client secret and the
 *  advertiser config; rebuild the four-field credential the provider needs. */
function toVibeCredential(cred: ConnectorCredential) {
  return {
    apiKey: cred.accessToken,
    apiSecret: (cred.config.api_secret as string | undefined) ?? null,
    accountId: cred.accountId,
    config: cred.config,
  }
}

export const vibeCtvConnector: AdConnector = {
  platform: VIBE_CTV_PLATFORM,

  /** The structure names OUR staged campaign row; the provider reads its
   *  creative/geo/budget from that row and publishes on Vibe. */
  async publishCampaign(args: PublishArgs): Promise<PublishResult> {
    const campaignId = String(args.structure.campaign_id ?? "")
    if (!campaignId) return { ok: false, error: "structure.campaign_id required — a CTV publish reads the staged ad_campaigns row" }
    const { dispatchCtvCampaign } = await import("@/lib/providers/vibe")
    const r = await dispatchCtvCampaign(campaignId)
    return r.dispatched && r.vibeCampaignId
      ? { ok: true, externalCampaignId: r.vibeCampaignId }
      : { ok: false, error: r.reason }
  },

  async pushCustomAudience() {
    return { ok: false, recordsSynced: 0, recordsRejected: 0, error: "vibe_ctv: CRM audiences are HEM syncs under a Vibe advertiser — not wired; targeting is geography + device only (Fair Housing)" }
  },

  async createLookalike() {
    return { ok: false, recordsSynced: 0, recordsRejected: 0, error: "vibe_ctv: lookalike audiences are not offered on the streaming-TV lane" }
  },

  /**
   * Two-phase, because Vibe reporting is async (POST /reports → poll → download):
   *   pass N   — no pending report → request one, return pending {report_id}
   *   pass N+1 — read it; READY → the row (and request the next window);
   *              still processing → pending again; failed → drop the id so the
   *              next pass requests afresh.
   * "clicks" for a TV spot = attributed page views (see VibePerformanceTotals).
   */
  async fetchPerformance(args: PerformanceQuery): Promise<PerformanceFetchResult> {
    const { requestVibeCampaignReport, readVibeCampaignReport } = await import("@/lib/providers/vibe")
    const conn = toVibeCredential(args.cred)
    const pendingId = (args.providerState?.vibe_report_id as string | undefined) ?? null
    if (!pendingId) {
      const { reportId } = await requestVibeCampaignReport({ conn, vibeCampaignId: args.campaignExternalId, sinceIso: args.sinceIso })
      return { pending: true, providerState: { vibe_report_id: reportId, vibe_report_requested_at: new Date().toISOString() } }
    }
    const out = await readVibeCampaignReport(conn, pendingId, args.campaignExternalId)
    if (out.kind === "pending") return { pending: true, providerState: { ...args.providerState, vibe_report_id: pendingId } }
    if (out.kind === "failed") {
      console.error("[vibe-ctv] report failed, will re-request next pass:", out.reason)
      return { pending: true, providerState: { vibe_report_id: null, vibe_report_last_error: out.reason } }
    }
    const t = out.row
    const clicks = t.pageViews
    const leads = t.leads
    const spend = Math.round(t.spend * 100) / 100
    return {
      spend,
      impressions: t.impressions,
      clicks,
      leads,
      conversions: t.purchases + t.signups,
      revenue: Math.round(t.purchaseAmount * 100) / 100,
      ...deriveMetrics({ spend, impressions: t.impressions, clicks, leads }),
    }
  },
}
