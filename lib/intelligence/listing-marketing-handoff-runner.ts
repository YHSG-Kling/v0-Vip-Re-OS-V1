// lib/intelligence/listing-marketing-handoff-runner.ts
//
// Live side of the LISTING MARKETING HANDOFF — when a listing reaches coming-soon or goes live,
// announce the Listing Concierge → Campaign Orchestrator handoff on the inter-manager bus so the
// marketing pickup is a VISIBLE coordinated team play, not just a silent sequence enrollment. This
// COMPLEMENTS the existing kernel-event fanout (which still enrolls the sequences); it does not
// re-produce marketing. Idempotent per (listing, stage). Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { marketingHandoffForStage } from "./listing-marketing-handoff"

type Svc = ReturnType<typeof createServiceClient>

export interface AnnounceMarketingHandoffArgs {
  brokerageId: string
  listingId: string
  targetStage: string
  propertyAddress?: string | null
}

export async function announceListingMarketingHandoff(args: AnnounceMarketingHandoffArgs, client?: Svc): Promise<{ announced: boolean; stage: string | null }> {
  const svc = client ?? createServiceClient()
  const handoff = marketingHandoffForStage(args.targetStage)
  if (!handoff.announce || !handoff.stage) return { announced: false, stage: null }

  // Idempotent — one announcement per (listing, stage).
  const { data: prior } = await svc.from("manager_signals")
    .select("id").eq("brokerage_id", args.brokerageId)
    .eq("signal_type", "listing_marketing_ready").eq("entity_id", args.listingId)
    .ilike("message", `%${handoff.stage}%`).limit(1).maybeSingle()
  if (prior) return { announced: false, stage: handoff.stage }

  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const addr = args.propertyAddress ?? "a listing"
    const what = handoff.stage === "coming_soon"
      ? `${addr} is coming soon — coordinate the pre-MLS teaser push`
      : `${addr} is live — coordinate the just-listed push (social + email + ads)`
    const r = await publishManagerSignal({
      brokerageId: args.brokerageId, fromManager: "listing_concierge", toManager: "campaign_orchestrator",
      signalType: "listing_marketing_ready",
      message: `Marketing handoff: ${what}.`,
      entityType: "listing", entityId: args.listingId,
      payload: { stage: handoff.stage, play: handoff.play, property_address: args.propertyAddress ?? null },
    }, svc)
    return { announced: !!(r as any).ok, stage: handoff.stage }
  } catch {
    return { announced: false, stage: handoff.stage }
  }
}
