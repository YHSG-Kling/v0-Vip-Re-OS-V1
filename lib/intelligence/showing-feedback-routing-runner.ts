// lib/intelligence/showing-feedback-routing-runner.ts
//
// Live side of SHOWING-FEEDBACK ROUTING — given a listing's weekly buyer-sentiment summary, decide
// the Listing Concierge play (pure routeShowingFeedback) and, when there is one, hand it to the
// concierge over the inter-manager bus so it proposes a GATED seller recommendation. Idempotent per
// (listing, play) within the week so the weekly cron never double-routes. Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { routeShowingFeedback, type ShowingFeedbackInput } from "./showing-feedback-routing"

type Svc = ReturnType<typeof createServiceClient>

export interface RouteShowingFeedbackArgs {
  brokerageId: string
  listingId: string
  sellerContactId: string | null
  propertyAddress?: string | null
  isInHouse: boolean
  summary: ShowingFeedbackInput
}

export async function routeAndPublishShowingFeedback(args: RouteShowingFeedbackArgs, client?: Svc): Promise<{ routed: boolean; play: string | null }> {
  const svc = client ?? createServiceClient()
  const routing = routeShowingFeedback(args.summary, { isInHouse: args.isInHouse })
  if (!routing.play || !routing.toManager) return { routed: false, play: null }
  if (!args.sellerContactId) return { routed: false, play: routing.play } // need the seller to address

  // Idempotent: don't re-route the same play for the same listing within the week.
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { data: prior } = await svc.from("manager_signals")
    .select("id").eq("brokerage_id", args.brokerageId)
    .eq("signal_type", "showing_feedback_routed").eq("entity_id", args.listingId)
    .gte("created_at", since).ilike("message", `%${routing.play}%`).limit(1).maybeSingle()
  if (prior) return { routed: false, play: routing.play }

  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const r = await publishManagerSignal({
      brokerageId: args.brokerageId, fromManager: "listing_concierge", toManager: "listing_concierge",
      signalType: "showing_feedback_routed",
      message: `Showing feedback routed the ${routing.play} play${routing.urgency === "now" ? " — urgent" : ""}: ${routing.reason}.`,
      entityType: "listing", entityId: args.listingId, contactId: args.sellerContactId,
      payload: { play: routing.play, coachingPoints: routing.coachingPoints, urgency: routing.urgency, property_address: args.propertyAddress ?? null },
    }, svc)
    return { routed: !!(r as any).ok, play: routing.play }
  } catch {
    return { routed: false, play: routing.play }
  }
}
