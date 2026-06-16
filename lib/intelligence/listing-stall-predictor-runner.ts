// lib/intelligence/listing-stall-predictor-runner.ts
//
// Live side of the LISTING-STALL PREDICTOR — for an active in-house listing, gather the real signals
// (days on market from go_live/listing date, showing momentum over two 14-day windows, offer count),
// predict the stall (pure predictListingStall), and when it's heading for one hand the play to the
// Listing Concierge over the bus EARLY (before relist_recovery's after-the-fact net). Idempotent per
// (listing, play) within the window. Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { predictListingStall } from "./listing-stall-predictor"

type Svc = ReturnType<typeof createServiceClient>
const DAY = 86_400_000

export interface PredictStallArgs {
  brokerageId: string
  listingId: string
  sellerContactId: string | null
  propertyAddress?: string | null
  goLiveAt: string | null
  areaMedianDom?: number | null
  now?: string
}

export async function predictAndPublishStall(args: PredictStallArgs, client?: Svc): Promise<{ published: boolean; risk: string; play: string | null }> {
  const svc = client ?? createServiceClient()
  const nowMs = new Date(args.now ?? new Date().toISOString()).getTime()
  if (!args.goLiveAt) return { published: false, risk: "none", play: null }
  const daysOnMarket = Math.max(0, Math.floor((nowMs - new Date(args.goLiveAt).getTime()) / DAY))

  // Showing momentum — two 14-day windows.
  const w0 = new Date(nowMs - 14 * DAY).toISOString()
  const w1 = new Date(nowMs - 28 * DAY).toISOString()
  const countShowings = async (from: string, to: string): Promise<number> => {
    const { count } = await svc.from("showings").select("id", { count: "exact", head: true })
      .eq("listing_id", args.listingId).gte("scheduled_at", from).lt("scheduled_at", to)
    return count ?? 0
  }
  const [showingsLast14, showingsPrev14] = await Promise.all([
    countShowings(w0, new Date(nowMs).toISOString()),
    countShowings(w1, w0),
  ])

  // Offers to date.
  const { count: offers } = await svc.from("offers").select("id", { count: "exact", head: true })
    .eq("listing_id", args.listingId)

  const prediction = predictListingStall({
    daysOnMarket, areaMedianDom: args.areaMedianDom ?? null,
    showingsLast14, showingsPrev14, offers: offers ?? 0,
  })

  if (!prediction.willStall || !prediction.recommendedPlay || prediction.recommendedPlay === "hold") {
    return { published: false, risk: prediction.risk, play: prediction.recommendedPlay }
  }
  if (!args.sellerContactId) return { published: false, risk: prediction.risk, play: prediction.recommendedPlay }

  // Idempotent: don't re-predict the same play for the same listing within ~10 days.
  const since = new Date(nowMs - 10 * DAY).toISOString()
  const { data: prior } = await svc.from("manager_signals")
    .select("id").eq("brokerage_id", args.brokerageId).eq("signal_type", "listing_stall_predicted")
    .eq("entity_id", args.listingId).gte("created_at", since).ilike("message", `%${prediction.recommendedPlay}%`).limit(1).maybeSingle()
  if (prior) return { published: false, risk: prediction.risk, play: prediction.recommendedPlay }

  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const r = await publishManagerSignal({
      brokerageId: args.brokerageId, fromManager: "listing_concierge", toManager: "listing_concierge",
      signalType: "listing_stall_predicted",
      message: `Stall predicted (${prediction.risk}) on ${args.propertyAddress ?? "a listing"} — run the ${prediction.recommendedPlay} play early: ${prediction.reasons[0] ?? ""}`,
      entityType: "listing", entityId: args.listingId, contactId: args.sellerContactId,
      payload: { play: prediction.recommendedPlay, risk: prediction.risk, reasons: prediction.reasons, property_address: args.propertyAddress ?? null },
    }, svc)
    return { published: !!(r as any).ok, risk: prediction.risk, play: prediction.recommendedPlay }
  } catch {
    return { published: false, risk: prediction.risk, play: prediction.recommendedPlay }
  }
}
