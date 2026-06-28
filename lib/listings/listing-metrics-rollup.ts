// lib/listings/listing-metrics-rollup.ts
// ─────────────────────────────────────────────────────────────────────────────
// LISTING-METRICS ROLLUP — the missing writer for listing_metrics (Listing Concierge domain).
//
// Every seller-facing proof-of-work surface (portal ListingActivityCard, resolve-seller-context, the
// seller-updates DOM calc) READS listing_metrics, but nothing ever WROTE it — so sellers saw 0 views /
// 0 showings / 0 saves / 0 inquiries and DOM computed to 0. This aggregates the REAL written sources
// keyed to the listing — showings, saved_properties (non-dismissed), listing_inquiries, and
// property_views — into ONE cumulative row per listing (UPSERT on the m237 unique index), anchored to
// the listing's market-start date so DOM is correct. Idempotent, best-effort per listing, never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { pickMarketStartDate, sumViewCounts } from "./listing-metrics-shape"

type Svc = ReturnType<typeof createServiceClient>

export interface ListingMetricsRollupResult { listings: number; upserted: number }

/** Active inventory whose seller portal surfaces these metrics. */
const ACTIVE_STATUSES = ["active", "coming_soon", "pending"]

export async function rollupListingMetrics(
  brokerageId: string, client?: Svc, opts?: { limit?: number; now?: Date },
): Promise<ListingMetricsRollupResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: ListingMetricsRollupResult = { listings: 0, upserted: 0 }
  if (!brokerageId) return result

  const { data: listings } = await svc.from("listings")
    .select("id, go_live_date, listing_date, created_at")
    .eq("brokerage_id", brokerageId)
    .in("status", ACTIVE_STATUSES)
    .limit(opts?.limit ?? 200)

  for (const l of (listings ?? []) as Array<{ id: string; go_live_date: string | null; listing_date: string | null; created_at: string | null }>) {
    result.listings++
    try {
      // Counts from the listing-keyed written sources + summed views from property_views.
      const [showings, saves, inquiries, views] = await Promise.all([
        svc.from("showings").select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId).eq("listing_id", l.id),
        svc.from("saved_properties").select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId).eq("listing_id", l.id).eq("dismissed", false),
        svc.from("listing_inquiries").select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId).eq("listing_id", l.id),
        svc.from("property_views").select("view_count")
          .eq("brokerage_id", brokerageId).eq("property_id", l.id),
      ])

      const row = {
        listing_id: l.id,
        brokerage_id: brokerageId,
        date: pickMarketStartDate(l, now),
        views: sumViewCounts(views.data as Array<{ view_count: number | null }> | null),
        saves: saves.count ?? 0,
        inquiries: inquiries.count ?? 0,
        showings: showings.count ?? 0,
      }
      const { error } = await svc.from("listing_metrics").upsert(row, { onConflict: "listing_id" })
      if (!error) result.upserted++
    } catch { /* best-effort per listing */ }
  }
  return result
}
