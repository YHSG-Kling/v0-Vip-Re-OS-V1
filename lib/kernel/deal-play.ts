// lib/kernel/deal-play.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE DEAL PLAY — the AI team working a listing VISIBLY, like a human team in a
// deal room. One button on the listing page runs the whole play:
//
//   Listing Concierge  →  stages the launch (open-house draft, launch checklist)
//   Asset Manager      →  cuts the listing promo reel (canonical Remotion rail)
//   Campaign Orchestr. →  social + email + newsletter + blog drafts
//   Ads Manager        →  the just-listed ad campaign draft + a geo campaign
//
// Every artifact is GATED (drafts / pending approval — nothing publishes), and
// every hop is a manager_signals HANDOFF the command center narrates: the play
// IS the product demo. No new tables — the heavy lifting reuses the Launch War
// Room (now listing-scoped) + produceListingAdCampaign; this module adds the
// on-demand trigger and the four narrated handoffs. Idempotent per listing.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface DealPlayResult {
  ok: boolean
  alreadyRan?: boolean
  reason?: string
  reels: number
  channelsStaged: number
  openHousesProposed: number
  adsStaged: number
  handoffs: number
}

/** PURE: the four narrated hops of the play, from the staged counts. Each line
 *  is honest — it states what was actually staged, all gated. */
export function composePlayHandoffs(
  address: string,
  counts: { reels: number; channelsStaged: number; openHousesProposed: number; adsStaged: number },
): Array<{ from: string; to: string; signalType: string; message: string; consumedAction: string }> {
  return [
    {
      from: "listing_concierge", to: "asset_manager", signalType: "deal_play_prep_ready",
      message: `Deal Play on ${address}: launch staged${counts.openHousesProposed ? " (open-house draft proposed)" : ""} — cut the promo reel.`,
      consumedAction: "launch prep staged (gated)",
    },
    {
      from: "asset_manager", to: "campaign_orchestrator", signalType: "deal_play_reel_ready",
      message: counts.reels > 0
        ? `Promo reel for ${address} is staged on the render rail (pending approval) — take the campaign.`
        : `Reel already staged earlier for ${address} — campaign can proceed.`,
      consumedAction: counts.reels > 0 ? "reel commissioned (pending approval)" : "reel previously staged (deduped)",
    },
    {
      from: "campaign_orchestrator", to: "ads_manager", signalType: "deal_play_campaign_ready",
      message: counts.channelsStaged > 0
        ? `${counts.channelsStaged} channel drafts (social/email/newsletter/blog) staged for ${address} — propose the paid push.`
        : `Channel drafts already staged for ${address} — propose the paid push.`,
      consumedAction: `${counts.channelsStaged} channel drafts staged (approval-gated)`,
    },
    {
      from: "ads_manager", to: "listing_concierge", signalType: "deal_play_ads_ready",
      message: counts.adsStaged > 0
        ? `Ad campaign draft(s) for ${address} are in the approval queue — the play is staged end to end, one review to launch.`
        : `Ad drafts already existed for ${address} — the play is staged end to end.`,
      consumedAction: "ad drafts in the approval queue — play complete",
    },
  ]
}

/**
 * Run the Deal Play for one listing: convene the (listing-scoped) war room,
 * add the just-listed ad campaign, and narrate the four handoffs on the bus.
 * Idempotent — one play per listing (keyed on the first handoff signal).
 */
export async function runDealPlay(
  brokerageId: string,
  listingId: string,
  client?: Svc,
): Promise<DealPlayResult> {
  const svc = client ?? createServiceClient()
  const zero = { reels: 0, channelsStaged: 0, openHousesProposed: 0, adsStaged: 0 }

  const { data: listing } = await svc.from("listings")
    .select("id, address, city, status, agent_id")
    .eq("id", listingId).eq("brokerage_id", brokerageId).maybeSingle()
  if (!listing) return { ok: false, reason: "Listing not found", ...zero, handoffs: 0 }
  const l = listing as any
  if (!l.address) return { ok: false, reason: "Listing needs an address before the play can run", ...zero, handoffs: 0 }
  if (!["coming_soon", "active"].includes(l.status ?? "")) {
    return { ok: false, reason: `The play runs on coming-soon/active listings (status: ${l.status ?? "unset"})`, ...zero, handoffs: 0 }
  }

  // One play per listing — the first handoff signal is the idempotency key.
  const { data: prior } = await svc.from("manager_signals").select("id")
    .eq("brokerage_id", brokerageId).eq("signal_type", "deal_play_prep_ready")
    .eq("entity_id", listingId).limit(1).maybeSingle()
  if (prior) return { ok: true, alreadyRan: true, ...zero, handoffs: 0 }

  // ── The bench does the work (all gated, idempotent per producer) ────────────
  const { runLaunchWarRoom } = await import("@/lib/kernel/launch-war-room")
  const war = await runLaunchWarRoom(brokerageId, { onlyListingId: listingId }, svc)

  const { produceListingAdCampaign } = await import("@/lib/ads/listing-ad-producer")
  const ad = await produceListingAdCampaign(brokerageId, listingId, "just_listed", svc)

  const counts = {
    reels: war.reels,
    channelsStaged: war.channelsStaged,
    openHousesProposed: war.openHousesProposed,
    adsStaged: war.adsStaged + (ad.produced ? 1 : 0),
  }

  // ── Narrate the four hops (publish → mark consumed with the real action) ────
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  const where = l.city ? `${l.address}, ${l.city}` : l.address
  let handoffs = 0
  for (const hop of composePlayHandoffs(where, counts)) {
    const r = await publishManagerSignal({
      brokerageId,
      fromManager: hop.from as any, toManager: hop.to as any,
      signalType: hop.signalType, message: hop.message,
      entityType: "listing", entityId: listingId,
    }, svc)
    if (r.ok && r.signalId && !r.reason) {
      await svc.from("manager_signals")
        .update({ status: "consumed", consumed_at: new Date().toISOString(), consumed_action: hop.consumedAction })
        .eq("id", r.signalId)
      handoffs += 1
    }
  }

  return { ok: true, ...counts, handoffs }
}
