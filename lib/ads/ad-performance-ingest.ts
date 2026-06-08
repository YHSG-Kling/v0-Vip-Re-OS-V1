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

export interface IngestResult { campaigns: number; ingested: number; skipped: number }

/**
 * For every LIVE campaign in a brokerage, fetch performance from its platform and
 * write an ad_performance snapshot. Best-effort per campaign. A campaign with no
 * external id or no connected credential is skipped (not an error).
 */
export async function ingestAdPerformance(
  brokerageId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<IngestResult> {
  const supabase = client ?? createServiceClient()
  const { data: campaigns } = await supabase
    .from("ad_campaigns")
    .select("id, platform, status, targeting_config")
    .eq("brokerage_id", brokerageId)
    .in("status", ["live", "launching"])
  const live = (campaigns ?? []) as Array<{ id: string; platform: string; targeting_config: Record<string, unknown> | null }>

  let ingested = 0, skipped = 0
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
  }
  return { campaigns: live.length, ingested, skipped }
}
