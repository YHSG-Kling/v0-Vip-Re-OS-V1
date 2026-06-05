/**
 * app/api/cron/variant-outcomes-aggregator/route.ts
 *
 * Wave 36 — closes the bandit feedback loop. Daily cron that joins
 * qr_scan_events from the last 24h to their originating direct_mail_
 * campaigns row (via qr_code_id) to direct_mail_variant_outcomes (via
 * the campaign's variant_id), and increments scans_count on the
 * outcomes row.
 *
 * Why daily (not realtime): each scan is a noisy individual event;
 * the bandit picks based on accumulated counts. Updating once per day
 * is plenty for week-scale exploration. Realtime is a future
 * optimization if we ever want sub-day adaptation.
 *
 * Schedule: 30 8 * * * — daily 08:30 UTC, after the content-
 * performance-aggregator (08:00) so the topic + variant signals
 * converge on the same daily cadence.
 *
 * Auth: CRON_SECRET.
 *
 * Idempotency: We track the last-seen scan timestamp via the
 * outcomes row's updated_at. Window is (max(last_run, T-25h), now()]
 * so a missed run catches up; the unique constraint on (variant_id,
 * brokerage_id) means re-running the same window simply re-bumps
 * counts which we GUARD against by only counting scans that arrived
 * since the row's updated_at.
 *
 * For the v1 we use a simpler approach: a single (brokerage,
 * variant) → COUNT of scans in the last 24h window. updated_at ≥ the
 * window start prevents double-counting across overlapping cron
 * windows.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

export async function GET(req: NextRequest) {
  const auth     = req.headers.get("authorization")?.replace("Bearer ", "")
  const qs       = new URL(req.url).searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return unauthorized()

  const svc = createServiceClient()

  // Window: last 25h to catch overlap from previous run + tolerance.
  const windowStart = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  const windowStartMs = new Date(windowStart).getTime()

  // 1. Pull scan events in the window — join via qr_code_id to
  //    direct_mail_campaigns to get (brokerage_id, variant_id).
  const { data: scanRows } = await svc
    .from("qr_scan_events")
    .select("qr_code_id, scanned_at")
    .gte("scanned_at", windowStart)
    .not("qr_code_id", "is", null)
    .limit(20_000)

  type ScanRow = { qr_code_id: string; scanned_at: string }
  const scans = (scanRows ?? []) as ScanRow[]
  if (scans.length === 0) {
    return NextResponse.json({ ran_at: new Date().toISOString(), scans_processed: 0, outcomes_updated: 0 })
  }

  // 2. Bulk-load the campaign rows for these QR codes.
  const qrIds = [...new Set(scans.map((s) => s.qr_code_id))]
  const { data: campaignRows } = await svc
    .from("direct_mail_campaigns")
    .select("qr_code_id, brokerage_id, variant_id")
    .in("qr_code_id", qrIds)
    .not("variant_id", "is", null)
  type CRow = { qr_code_id: string; brokerage_id: string; variant_id: string }
  const campaigns = (campaignRows ?? []) as CRow[]

  // qr_code_id → { brokerage_id, variant_id }. A QR code might be on
  // multiple campaigns (unusual but possible — same QR re-attached to
  // a later piece); we pick the first, which is fine because the
  // FK targets the canonical variant.
  const qrToCampaign = new Map<string, { brokerage_id: string; variant_id: string }>()
  for (const c of campaigns) {
    if (!qrToCampaign.has(c.qr_code_id)) {
      qrToCampaign.set(c.qr_code_id, { brokerage_id: c.brokerage_id, variant_id: c.variant_id })
    }
  }

  // 3. Count scans per (variant_id, brokerage_id) within the window.
  const scansByVariant = new Map<string, { brokerageId: string; variantId: string; scans: number; lastScanAt: string }>()
  for (const s of scans) {
    const meta = qrToCampaign.get(s.qr_code_id)
    if (!meta) continue
    const key = `${meta.brokerage_id}|${meta.variant_id}`
    const existing = scansByVariant.get(key)
    if (existing) {
      existing.scans++
      if (s.scanned_at > existing.lastScanAt) existing.lastScanAt = s.scanned_at
    } else {
      scansByVariant.set(key, {
        brokerageId: meta.brokerage_id,
        variantId:   meta.variant_id,
        scans:       1,
        lastScanAt:  s.scanned_at,
      })
    }
  }

  // 4. For each (variant, brokerage), increment the outcomes row.
  //    Guard against double-counting: only bump if updated_at < the
  //    window start (i.e. the row hasn't already been advanced past
  //    this window by an earlier overlapping run).
  let updated = 0
  for (const v of scansByVariant.values()) {
    const { data: existing } = await svc
      .from("direct_mail_variant_outcomes")
      .select("id, scans_count, updated_at")
      .eq("variant_id", v.variantId)
      .eq("brokerage_id", v.brokerageId)
      .maybeSingle()
    if (!existing) {
      // No outcomes row yet — create one with these scans. (Sends
      // would normally land first via recordVariantSend, but a slow
      // bandit pick path could let scans arrive first if the variant
      // FK is somehow stale; cover the case.)
      await svc.from("direct_mail_variant_outcomes").insert({
        variant_id:    v.variantId,
        brokerage_id:  v.brokerageId,
        sends_count:   0,
        scans_count:   v.scans,
        last_scan_at:  v.lastScanAt,
        updated_at:    new Date().toISOString(),
      })
      updated++
      continue
    }
    if ((existing.updated_at as string) >= windowStart) {
      // Already advanced past this window — skip to avoid double-count.
      continue
    }
    await svc.from("direct_mail_variant_outcomes")
      .update({
        scans_count:   (existing.scans_count as number) + v.scans,
        last_scan_at:  v.lastScanAt,
        updated_at:    new Date().toISOString(),
      })
      .eq("id", existing.id)
    updated++
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    window_start: windowStart,
    scans_processed: scans.length,
    variant_keys_seen: scansByVariant.size,
    outcomes_updated: updated,
  })
}
