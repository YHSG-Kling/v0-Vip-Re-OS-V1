/**
 * Sprint 9 — Marketing campaign measurer.
 *
 * Aggregates per-asset metrics back to the parent marketing_campaigns row:
 *   impressions    — newsletter recipients + blog views + qr scans
 *   engagements    — newsletter opens + clicks + qr lead conversions + social engagement
 *   conversions    — qr.lead_count + direct-mail-response leads
 *
 * Run by the marketing-campaign-scheduler cron (or on-demand). Writes
 * idempotently — re-running just refreshes the rollup snapshot.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface CampaignMetrics {
  campaignId:    string
  impressions:   number
  engagements:   number
  conversions:   number
}

export async function syncCampaignMetricsSafe(campaignId: string): Promise<CampaignMetrics | null> {
  const svc = createServiceClient()

  // Newsletter rollup: count active sends, derive opens/clicks from open_rate
  const { data: newsletters } = await svc
    .from("newsletter_campaigns")
    .select("id, status, open_rate, click_rate")
    .eq("marketing_campaign_id", campaignId)

  // Blog rollup: published blog posts count toward impressions (proxy via
  // existence — actual view tracking lives on knowledge_articles for the
  // collapsed Sprint 7 surface; blog_posts has no view_count column today).
  const { data: blogs } = await svc
    .from("blog_posts")
    .select("id, publish_status")
    .eq("marketing_campaign_id", campaignId)

  // QR rollup: scan_count + lead_count.
  //
  // TWO LINKAGES, ONE ROLLUP. `qr_codes.marketing_campaign_id` is the FORWARD
  // link and was the only one this rollup read — which measured zero for every
  // campaign for as long as no minter wrote that column. The other link, the one
  // that has carried data all along, is the reverse one,
  // `direct_mail_campaigns.qr_code_id`: the mail piece names the code it prints,
  // and that campaign row carries the marketing_campaign_id. Codes reached that
  // way are folded in below, DEDUPED BY QR ID so a code that is linked both ways
  // is counted once.
  const { data: qrs, error: qrsError } = await svc
    .from("qr_codes")
    .select("id, scan_count, lead_count")
    .eq("marketing_campaign_id", campaignId)
  if (qrsError) console.error("[campaign-measurer] QR rollup read failed:", qrsError.message)

  // Social rollup: published posts engagement_data jsonb
  const { data: social } = await svc
    .from("social_posts")
    .select("id, status, engagement_data")
    .eq("marketing_campaign_id", campaignId)

  // Direct mail rollup: pieces_mailed (impressions) + estimated_response_rate
  // applied to pieces_mailed for an estimated-conversions proxy until we have
  // first-class delivery tracking.
  const { data: dm, error: dmError } = await svc
    .from("direct_mail_campaigns")
    .select("id, status, pieces_mailed, estimated_response_rate, qr_code_id")
    .eq("marketing_campaign_id", campaignId)
  if (dmError) console.error("[campaign-measurer] direct-mail rollup read failed:", dmError.message)

  // The reverse-linked codes (see the QR rollup note above), minus anything the
  // forward link already returned.
  const forwardQrIds = new Set(((qrs ?? []) as Array<{ id: string }>).map((q) => q.id))
  const reverseQrIds = [...new Set(
    ((dm ?? []) as Array<{ qr_code_id: string | null }>)
      .map((d) => d.qr_code_id)
      .filter((id): id is string => !!id && !forwardQrIds.has(id)),
  )]
  let reverseQrs: Array<{ scan_count: number | null; lead_count: number | null }> = []
  if (reverseQrIds.length > 0) {
    const { data: reverse, error: reverseError } = await svc
      .from("qr_codes")
      .select("id, scan_count, lead_count")
      .in("id", reverseQrIds)
    if (reverseError) {
      console.error("[campaign-measurer] mail-linked QR rollup read failed:", reverseError.message)
    }
    reverseQrs = (reverse ?? []) as Array<{ scan_count: number | null; lead_count: number | null }>
  }

  let impressions = 0
  let engagements = 0
  let conversions = 0

  for (const n of (newsletters ?? []) as Array<{ status: string | null; open_rate: number | null; click_rate: number | null }>) {
    if (n.status === "sent" || n.status === "active") {
      // Each sent newsletter counts as 1 impression baseline; opens/clicks
      // multiply via open_rate × audience (proxy: 100 if unknown).
      impressions += 1
      engagements += Math.round(((n.open_rate ?? 0) + (n.click_rate ?? 0)) * 100)
    }
  }

  for (const b of (blogs ?? []) as Array<{ publish_status: string | null }>) {
    if (b.publish_status === "published") impressions += 1
  }

  for (const q of [
    ...((qrs ?? []) as Array<{ scan_count: number | null; lead_count: number | null }>),
    ...reverseQrs,
  ]) {
    impressions += q.scan_count ?? 0
    conversions += q.lead_count ?? 0
  }

  for (const s of (social ?? []) as Array<{ status: string | null; engagement_data: Record<string, unknown> | null }>) {
    if (s.status === "published") {
      impressions += 1
      const e = s.engagement_data ?? {}
      engagements += Number((e as Record<string, number>).likes      ?? 0)
                  +  Number((e as Record<string, number>).comments   ?? 0)
                  +  Number((e as Record<string, number>).shares     ?? 0)
    }
  }

  for (const d of (dm ?? []) as Array<{ status: string | null; pieces_mailed: number | null; estimated_response_rate: number | null }>) {
    if (d.status === "approved" || d.status === "in_production" || d.status === "mailed") {
      impressions += d.pieces_mailed ?? 0
      conversions += Math.round((d.pieces_mailed ?? 0) * (d.estimated_response_rate ?? 0))
    }
  }

  const { error } = await svc
    .from("marketing_campaigns")
    .update({
      impressions,
      engagements,
      conversions,
      last_metrics_synced_at: new Date().toISOString(),
      updated_at:             new Date().toISOString(),
    })
    .eq("id", campaignId)
  if (error) {
    console.error("[campaign-measurer] update failed:", error.message)
    return null
  }

  return { campaignId, impressions, engagements, conversions }
}
