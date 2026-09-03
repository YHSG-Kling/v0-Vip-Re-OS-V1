/**
 * lib/ads/ad-performance-ingest.ts
 *
 * Wave 42 — pulls REAL ad performance from the platforms into ad_performance, so
 * the Ads Manager optimizes on actual cost-per-lead instead of seeded data. For
 * each live campaign, resolve the connector for its platform, fetch performance,
 * and upsert a snapshot row. The provider row → ad_performance column mapping is
 * pure (unit-tested); the fetch is credential-gated (skips cleanly with no token).
 */
import { createServiceClient } from "@/lib/supabase/service"
import { getConnector, loadConnectorCredential } from "./connectors/registry"
import type { ProviderPerformanceRow } from "./connectors/types"
import { recordAdPerformanceSnapshot, detectCreativeFatigue } from "./creative-fatigue-runner"

/** Pure: provider performance row → ad_performance insert payload. */
export function toAdPerformanceRow(brokerageId: string, campaignId: string, p: ProviderPerformanceRow): Record<string, unknown> {
  return {
    brokerage_id:    brokerageId,
    ad_campaign_id:  campaignId,
    captured_at:     new Date().toISOString(),
    spend:           p.spend,
    impressions:     p.impressions,
    clicks:          p.clicks,
    ctr:             p.ctr,
    leads:           p.leads,
    conversions:     p.conversions,
    cost_per_lead:   p.costPerLead,
    revenue_attributed: p.revenue,
  }
}

export interface IngestResult {
  campaigns: number
  ingested: number
  skipped: number
  /** ad_performance_history rows appended this pass (the time-series the fatigue monitor reads). */
  historyRecorded: number
  /** Campaigns whose CTR decay crossed the HIGH-risk bar and raised a gated creative_fatigue signal. */
  fatigued: number
}

/**
 * For every LIVE campaign in a brokerage, fetch performance from its platform and
 * write an ad_performance snapshot. Best-effort per campaign. A campaign with no
 * external id or no connected credential is skipped (not an error).
 */
export async function ingestAdPerformance(
  brokerageId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<IngestResult> {
  const supabase = client ?? createServiceClient()
  const { data: campaigns, error: campaignsError } = await supabase
    .from("ad_campaigns")
    .select("id, platform, status, targeting_config, campaign_name")
    .eq("brokerage_id", brokerageId)
    .in("status", ["live", "launching"])
  if (campaignsError) {
    // supabase-js RESOLVES a refusal; an un-read error here reported "0 live
    // campaigns" for a tenant whose read was refused.
    console.error("[ad-performance-ingest] ad_campaigns read refused:", campaignsError.message)
    return { campaigns: 0, ingested: 0, skipped: 0, historyRecorded: 0, fatigued: 0 }
  }
  const live = (campaigns ?? []) as Array<{ id: string; platform: string; targeting_config: Record<string, unknown> | null; campaign_name: string | null }>

  let ingested = 0, skipped = 0, historyRecorded = 0, fatigued = 0
  const ingestedCampaigns: Array<{ id: string; name: string | null }> = []
  // Cache one credential per platform per brokerage.
  const credCache = new Map<string, Awaited<ReturnType<typeof loadConnectorCredential>>>()

  for (const c of live) {
    const connector = getConnector(c.platform)
    if (!connector) { skipped++; continue }
    // The platform's campaign id is stored on targeting_config.external_campaign_id once launched.
    const externalId = (c.targeting_config?.external_campaign_id as string | undefined) ?? null
    if (!externalId) { skipped++; continue }
    if (!credCache.has(c.platform)) credCache.set(c.platform, await loadConnectorCredential(brokerageId, c.platform, supabase))
    const cred = credCache.get(c.platform)
    if (!cred) { skipped++; continue }

    const perf = await connector.fetchPerformance({ campaignExternalId: externalId, sinceIso: new Date(Date.now() - 30 * 86_400_000).toISOString(), cred })
    if (!perf) { skipped++; continue }
    const { error } = await supabase.from("ad_performance").insert(toAdPerformanceRow(brokerageId, c.id, perf))
    if (!error) ingested++; else skipped++
    if (error) continue

    // THE TIME-SERIES HALF (wired 2026-09-03). ad_performance keeps only the
    // latest reading per pass; ad_performance_history is what
    // lib/ads/creative-fatigue-runner.ts detectCreativeFatigue and
    // lib/ads/ad-outcome-loop.ts read — and NOTHING wrote it, so the fatigue
    // monitor (manager-registry creative_fatigue) always saw an empty series.
    const recorded = await recordAdPerformanceSnapshot({
      brokerageId, adCampaignId: c.id,
      ctr: perf.ctr, impressions: perf.impressions, clicks: perf.clicks,
      leads: perf.leads, costPerLead: perf.costPerLead,
    }, supabase)
    if (recorded) historyRecorded++
    ingestedCampaigns.push({ id: c.id, name: c.campaign_name ?? null })
  }

  // FATIGUE DETECTION runs AFTER this pass's readings land, per campaign. It
  // proposes a GATED refresh on the inter-manager bus only on HIGH risk and is
  // honest on thin data (the pure engine refuses to alarm on < MIN_SAMPLE points).
  for (const c of ingestedCampaigns) {
    try {
      const r = await detectCreativeFatigue({ brokerageId, adCampaignId: c.id, campaignName: c.name }, supabase)
      if (r.flagged) fatigued++
    } catch (e) {
      console.error("[ad-performance-ingest] fatigue detection failed for", c.id, (e as Error).message)
    }
  }
  return { campaigns: live.length, ingested, skipped, historyRecorded, fatigued }
}
