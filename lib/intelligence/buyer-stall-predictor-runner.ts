// lib/intelligence/buyer-stall-predictor-runner.ts
//
// Live side of the BUYER-STALL PREDICTOR — gather a buyer's real signals (tour volume + momentum over
// two 30-day windows, offers written, days since first tour), predict the stall (pure
// predictBuyerStall), and when they're stalling hand the play to the Shopping Agent over the bus so
// it proposes a GATED reset (recalibrate / re-energize). Idempotent per (contact, play). Best-effort.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { predictBuyerStall } from "./buyer-stall-predictor"

type Svc = ReturnType<typeof createServiceClient>
const DAY = 86_400_000

export interface PredictBuyerStallArgs {
  brokerageId: string
  contactId: string
  now?: string
}

export async function predictAndPublishBuyerStall(args: PredictBuyerStallArgs, client?: Svc): Promise<{ published: boolean; risk: string; play: string | null }> {
  const svc = client ?? createServiceClient()
  const nowMs = new Date(args.now ?? new Date().toISOString()).getTime()

  // Tours (showings) for this buyer.
  const { data: showings } = await svc.from("showings")
    .select("scheduled_at").eq("contact_id", args.contactId).limit(500)
  const tourTimes = ((showings ?? []) as { scheduled_at: string | null }[])
    .map((s) => (s.scheduled_at ? new Date(s.scheduled_at).getTime() : NaN))
    .filter((t) => Number.isFinite(t))
  const toursTotal = tourTimes.length
  if (toursTotal === 0) return { published: false, risk: "none", play: null }

  const toursLast30 = tourTimes.filter((t) => t >= nowMs - 30 * DAY).length
  const toursPrev30 = tourTimes.filter((t) => t < nowMs - 30 * DAY && t >= nowMs - 60 * DAY).length
  const daysSinceFirstTour = Math.floor((nowMs - Math.min(...tourTimes)) / DAY)

  // Offers written by this buyer.
  const { count: offersMade } = await svc.from("offers").select("id", { count: "exact", head: true })
    .eq("contact_id", args.contactId)

  const prediction = predictBuyerStall({ toursTotal, toursLast30, toursPrev30, offersMade: offersMade ?? 0, daysSinceFirstTour })

  if (!prediction.willStall || !prediction.recommendedPlay || prediction.recommendedPlay === "hold") {
    return { published: false, risk: prediction.risk, play: prediction.recommendedPlay }
  }

  // Idempotent — don't re-predict the same play for the same buyer within ~14 days.
  const since = new Date(nowMs - 14 * DAY).toISOString()
  const { data: prior } = await svc.from("manager_signals")
    .select("id").eq("brokerage_id", args.brokerageId).eq("signal_type", "buyer_stall_predicted")
    .eq("contact_id", args.contactId).gte("created_at", since).ilike("message", `%${prediction.recommendedPlay}%`).limit(1).maybeSingle()
  if (prior) return { published: false, risk: prediction.risk, play: prediction.recommendedPlay }

  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const r = await publishManagerSignal({
      brokerageId: args.brokerageId, fromManager: "shopping_agent", toManager: "shopping_agent",
      signalType: "buyer_stall_predicted",
      message: `Buyer stall predicted (${prediction.risk}) — run the ${prediction.recommendedPlay} play: ${prediction.reasons[0] ?? ""}`,
      entityType: "contact", entityId: args.contactId, contactId: args.contactId,
      payload: { play: prediction.recommendedPlay, risk: prediction.risk, reasons: prediction.reasons },
    }, svc)
    return { published: !!(r as any).ok, risk: prediction.risk, play: prediction.recommendedPlay }
  } catch {
    return { published: false, risk: prediction.risk, play: prediction.recommendedPlay }
  }
}
