// lib/kernel/launch-war-room.ts
//
// THE LISTING LAUNCH WAR ROOM — the new-listing bookend to the Farm Play. When a listing
// agreement is signed and the listing goes coming-soon/active, a great team doesn't fire
// one social post — it LAUNCHES: the whole bench convenes on day one. The LISTING_PUBLISHED
// reactor already fires the reel + ad creative; the War Room adds what's missing and makes
// it a visible, coordinated play:
//
//   · Asset Manager       — the coming-soon reel (canonical Remotion+D-ID rail)
//   · Marketing/Campaign  — social + email + newsletter + blog drafts across the channels
//   · Listing Concierge   — schedules the FIRST open house (open_houses) if none exists
//   · Data Steward        — a "coming soon" neighbor farm (scrape, seller-permission-gated)
//   · Ads Manager         — a geo campaign on the listing's city (draft)
//   · Campaign Orchestrator — one agent summary tying the launch together + the bus line
//
// Nothing publishes: every draft is gated, the open house is unpublished, the farm awaits
// seller permission. One War Room per listing. NOT server-only.

import { createServiceClient } from "@/lib/supabase/service"
import type { NeighborScraper } from "@/lib/kernel/neighbor-farm"
import type { PromoDispatcher } from "@/lib/kernel/voice-delegation"

type Svc = ReturnType<typeof createServiceClient>

export interface LaunchCopy { social: string; email: string; newsletter: string; blog: string; agentSummary: string }

/** Pure: the launch copy across channels — earned from the listing facts. */
export function composeLaunch(address: string, city: string | null, comingSoon: boolean): LaunchCopy {
  const where = city ? ` in ${city}` : ""
  const tag = comingSoon ? "COMING SOON" : "JUST LISTED"
  return {
    social: `${tag}: ${address}${where}. Be the first to see it — message me for a private preview before it hits the open market.`,
    email: `${tag}${where} — ${address}. I wanted you to see this before anyone else. Reply for the full details and a private showing.`,
    newsletter: `New ${comingSoon ? "coming-soon" : "listing"}${where}: ${address}. A standout on the market this week.`,
    blog: `Introducing ${address}${where}. Here's a closer look at the home, the neighborhood, and why it won't last.`,
    agentSummary: `Launch war room is staged for ${address}${where}: the coming-soon reel, social + email + newsletter + blog drafts, your first open house, a neighbor "coming soon" farm, and a geo ad — all waiting on your approval. Get the launch out the door in one review.`,
  }
}

export interface LaunchResult {
  launches: number
  reels: number
  channelsStaged: number
  openHousesScheduled: number
  neighborFarms: number
  adsStaged: number
  summariesProposed: number
}

/**
 * Convene a Launch War Room for each active/coming-soon listing with no war room yet.
 * Everything gated; idempotent per listing (the agent summary is the key).
 */
export async function runLaunchWarRoom(
  brokerageId: string,
  opts: { now?: Date; scraper?: NeighborScraper; promoDispatcher?: PromoDispatcher } = {},
  client?: Svc,
): Promise<LaunchResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const result: LaunchResult = {
    launches: 0, reels: 0, channelsStaged: 0, openHousesScheduled: 0, neighborFarms: 0, adsStaged: 0, summariesProposed: 0,
  }

  const { data: listings } = await supabase.from("listings")
    .select("id, address, city, status, agent_id, created_at").eq("brokerage_id", brokerageId)
    .in("status", ["coming_soon", "active"]).order("created_at", { ascending: false }).limit(50)

  for (const l of (listings ?? []) as any[]) {
    if (!l.address) continue
    const agentRowId = l.agent_id ?? null
    let agentUserId: string | null = null
    if (agentRowId) {
      const { data: ar } = await supabase.from("agents").select("user_id").eq("id", agentRowId).maybeSingle()
      agentUserId = (ar as any)?.user_id ?? null
    }

    // Idempotency: one War Room per listing.
    const { data: existing } = await supabase.from("agent_client_messages").select("id")
      .eq("brokerage_id", brokerageId).eq("entity_id", l.id).ilike("rationale", "LAUNCH WAR ROOM%").limit(1).maybeSingle()
    if (existing) continue

    const comingSoon = l.status === "coming_soon"
    const copy = composeLaunch(l.address, l.city ?? null, comingSoon)

    // 1) ASSET — the launch reel (canonical rail; injectable dispatcher for tests).
    if (agentUserId) {
      const dispatcher: PromoDispatcher = opts.promoDispatcher ?? (async (d) => {
        const { dispatchListingPromoVideo } = await import("@/lib/video/listing-promo-reactor")
        const r = await dispatchListingPromoVideo({ ...d, eventType: d.eventType })
        return { ok: r.ok, status: r.status, reason: r.reason }
      })
      const rr = await dispatcher({ brokerageId, listingId: l.id, agentUserId, eventType: comingSoon ? "coming_soon" : "just_listed", bypassPolicy: false })
      if (rr.ok && rr.status !== "skipped") result.reels += 1
    }

    // 2) THE BENCH — social + email + newsletter + blog (all channels, gated).
    if (agentRowId || agentUserId) {
      const { stageBenchDrafts } = await import("@/lib/kernel/marketing-bench")
      const b = await stageBenchDrafts({ brokerageId, agentRowId, agentUserId, listingId: l.id }, [
        { channel: "social", idemName: `Launch Social — ${l.address}`, subject: "", body: copy.social, socialPostType: comingSoon ? "coming_soon" : "new_listing", brief: "LAUNCH WAR ROOM — launch social" },
        { channel: "email", idemName: `Launch Email — ${l.address}`, subject: `${comingSoon ? "Coming soon" : "Just listed"} — ${l.address}`, body: copy.email, brief: "LAUNCH WAR ROOM — launch email" },
        { channel: "newsletter", idemName: `Launch Newsletter — ${l.address}`, subject: `New${comingSoon ? " coming-soon" : ""} listing — ${l.address}`, body: copy.newsletter, brief: "LAUNCH WAR ROOM — newsletter feature" },
        { channel: "blog", idemName: `Introducing ${l.address}`, subject: `A closer look at ${l.address}`, body: copy.blog, brief: "LAUNCH WAR ROOM — listing blog" },
      ], supabase)
      result.channelsStaged += b.staged.length
    }

    // 3) LISTING CONCIERGE — schedule the first open house if none exists (unpublished).
    if (agentRowId) {
      const { data: existOH } = await supabase.from("open_houses").select("id").eq("listing_id", l.id).limit(1).maybeSingle()
      if (!existOH) {
        // First open house: the upcoming Saturday, 11:00–14:00 (the agent can move it).
        const d = new Date(now.getTime()); const day = d.getUTCDay()
        const daysToSat = (6 - day + 7) % 7 || 7
        const sat = new Date(d.getTime() + daysToSat * 86_400_000)
        const { error } = await supabase.from("open_houses").insert({
          brokerage_id: brokerageId, listing_id: l.id, agent_id: agentRowId,
          title: `Open House — ${l.address}`, property_address: l.address,
          event_date: sat.toISOString().slice(0, 10), start_time: "11:00", end_time: "14:00",
          status: "scheduled", is_published: false, require_rsvp: true, allow_walkins: true,
        })
        if (!error) result.openHousesScheduled += 1
      }
    }

    // 4) DATA STEWARD — the "coming soon" neighbor farm (scrape, seller-permission-gated).
    if (agentUserId) {
      const { stageNeighborFarm } = await import("@/lib/kernel/neighbor-farm")
      const farm = await stageNeighborFarm(brokerageId, l.id, agentUserId, { scraper: opts.scraper }, supabase)
      if (farm.created) result.neighborFarms += 1
    }

    // 5) ADS — a geo campaign on the listing's city (draft).
    if (l.city) {
      const adName = `Launch Geo — ${l.address}`
      const { data: existAd } = await supabase.from("ad_campaigns").select("id")
        .eq("brokerage_id", brokerageId).eq("campaign_name", adName).limit(1).maybeSingle()
      if (!existAd) {
        const { error } = await supabase.from("ad_campaigns").insert({
          brokerage_id: brokerageId, campaign_name: adName, platform: "facebook",
          status: "draft", objective: "lead_generation",
          targeting_config: { locations: [l.city], play: "listing_launch", listing_id: l.id },
        })
        if (!error) result.adsStaged += 1
      }
    }

    // 6) CAMPAIGN ORCHESTRATOR — one agent summary + the bus convening line.
    if (agentUserId) {
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage({
        brokerageId, agentKind: "campaign_orchestrator", entityType: "listing", entityId: l.id, audience: "agent",
        subject: `🚀 Launch war room ready — ${l.address}`, body: copy.agentSummary,
        rationale: `LAUNCH WAR ROOM — ${l.address} ${comingSoon ? "coming soon" : "listed"}; the bench staged reel + all channels + open house + neighbor farm + geo ad; all gated.`,
        channel: "portal",
      }, supabase)
      if (res.ok) result.summariesProposed += 1
    }

    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const conv = await publishManagerSignal({
      brokerageId, fromManager: "listing_concierge", toManager: "campaign_orchestrator",
      signalType: "launch_war_room_convened",
      message: `Launch war room convened on ${l.address}: reel + social/email/newsletter/blog + open house + neighbor farm + geo ad staged — all awaiting your approval.`,
      entityType: "listing", entityId: l.id,
    }, supabase)
    if (conv.ok && conv.signalId && !conv.reason) {
      await supabase.from("manager_signals")
        .update({ status: "consumed", consumed_at: now.toISOString(), consumed_action: "launch war room staged across the bench (gated)" })
        .eq("id", conv.signalId)
    }

    result.launches += 1
  }

  return result
}
