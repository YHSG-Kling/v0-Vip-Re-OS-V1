// lib/listings/seller-weekly-report-runner.ts
// ─────────────────────────────────────────────────────────────────────────────
// SELLER WEEKLY REPORT writer (Listing Concierge domain) — the missing producer for the
// seller_weekly_reports table. For each live listing's seller, gather THIS WEEK's real evidence
// (showings, the listing_metrics rollup, feedback sentiment, marketing reach, DOM) and upsert a
// client-safe weekly digest the seller-mode portal surfaces. Idempotent per (listing, week) — runs on
// the daily proactive sweep, so the current week's report refreshes as activity comes in and finalizes
// at week end. Best-effort per listing; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { buildSellerWeeklyReport, weekStartMonday } from "./seller-weekly-report"
import { computeDaysOnMarket } from "@/lib/listings/compute-dom"

type Svc = ReturnType<typeof createServiceClient>

export interface SellerWeeklyReportResult { listings: number; upserted: number }

const ACTIVE_STATUSES = ["active", "coming_soon", "pending"]

export async function runSellerWeeklyReports(
  brokerageId: string, client?: Svc, opts?: { now?: Date; limit?: number },
): Promise<SellerWeeklyReportResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: SellerWeeklyReportResult = { listings: 0, upserted: 0 }
  if (!brokerageId) return result

  const weekStart = weekStartMonday(now)
  const weekStartIso = new Date(`${weekStart}T00:00:00.000Z`).toISOString()

  const { data: listings } = await svc.from("listings")
    .select("id, seller_contact_id, go_live_date")
    .eq("brokerage_id", brokerageId).in("status", ACTIVE_STATUSES)
    .not("seller_contact_id", "is", null)
    .limit(opts?.limit ?? 200)

  for (const l of (listings ?? []) as Array<{ id: string; seller_contact_id: string | null; go_live_date: string | null }>) {
    result.listings++
    try {
      const [metricsRes, weekShowingsRes, feedbackRes, socialRes] = await Promise.all([
        // The listing_metrics rollup — cumulative views/saves/inquiries/showings (now a live writer).
        svc.from("listing_metrics").select("views, saves, inquiries, showings")
          .eq("listing_id", l.id).order("date", { ascending: false }).limit(1).maybeSingle(),
        // Showings scheduled THIS week.
        svc.from("showings").select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId).eq("listing_id", l.id).gte("scheduled_at", weekStartIso),
        // Feedback sentiment from showing ratings (gentle — never quoted raw to the seller).
        svc.from("showings").select("rating")
          .eq("brokerage_id", brokerageId).eq("listing_id", l.id).not("rating", "is", null),
        // Distinct channels we can verify a published post on.
        svc.from("social_posts").select("platform")
          .eq("listing_id", l.id).eq("status", "published"),
      ])

      const m = (metricsRes.data ?? {}) as { views?: number; saves?: number; inquiries?: number; showings?: number }
      const ratings = ((feedbackRes.data ?? []) as Array<{ rating: number | null }>).map((r) => r.rating).filter((r): r is number => typeof r === "number")
      const feedback = {
        positive: ratings.filter((r) => r >= 4).length,
        neutral: ratings.filter((r) => r === 3).length,
        negative: ratings.filter((r) => r < 3).length,
      }
      const platforms = new Set(((socialRes.data ?? []) as Array<{ platform: string | null }>).map((p) => p.platform).filter(Boolean))
      const marketingChannelsActive = platforms.size + 1 // + the hosted listing page

      const report = buildSellerWeeklyReport({
        weekStart,
        showingsThisWeek: weekShowingsRes.count ?? 0,
        totalShowings: m.showings ?? 0,
        views: m.views ?? 0,
        saves: m.saves ?? 0,
        inquiries: m.inquiries ?? 0,
        daysOnMarket: computeDaysOnMarket(l.go_live_date),
        feedback,
        marketingChannelsActive,
      })

      const { error } = await svc.from("seller_weekly_reports").upsert({
        listing_id: l.id,
        contact_id: l.seller_contact_id,
        brokerage_id: brokerageId,
        report_week_start: weekStart,
        report_content: report,
        generated_at: now.toISOString(),
      }, { onConflict: "listing_id,report_week_start" })
      if (!error) result.upserted++
    } catch { /* best-effort per listing */ }
  }
  return result
}
