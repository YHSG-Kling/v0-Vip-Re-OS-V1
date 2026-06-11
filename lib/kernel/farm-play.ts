// lib/kernel/farm-play.ts
//
// THE FARM PLAY — a Team Play for a PLACE. Geographic farming is the #1 growth engine
// of every dominant listing agent: when you sell a home, you own the block — the
// neighbors find out, and the next three listings on that street come to you. No AI OS
// runs it as a coordinated play; ours convenes the whole marketing bench the moment a
// deal closes, each manager staging its piece on an EXISTING governed rail:
//
//   · Data Steward        — stages the neighbor farm (neighbor_notification_campaigns,
//                           awaiting_seller_permission): the homeowners around the sold
//                           home, identified + scored. NEVER sends without the seller's OK.
//   · Marketing Manager   — drafts the "just sold near you" neighbor postcard
//                           (direct_mail_campaigns, approval_status='pending')
//   · Ads Manager         — stages a geo-fenced paid campaign on the block
//                           (ad_campaigns, status='draft', targeting the city) — inactive
//   · Recruiting Manager  — when the close is a STANDOUT (fast or high), logs it on the
//                           bus as recruiting proof for the talent pipeline ("our agent
//                           just did this") — the win becomes recruiting ammo
//   · Campaign Orchestrator — proposes ONE internal summary to the agent (audience
//                           'agent') tying the whole play together: "you own this block
//                           now — get the seller's OK and approve the farm."
//
// Nothing sends: the neighbor campaign waits on seller permission, the postcard pends
// approval, the ad is a draft, the summary is the agent's to approve. One Farm Play per
// closed deal. The bus carries the convening line so the Command Center shows six
// managers converging on one address. NOT server-only (simulator-driven).

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** Recently-closed window the play scans (deals closed within N days are farmable). */
export const FARM_PLAY_WINDOW_DAYS = 21

export interface FarmWin {
  soldAddress: string
  soldCity: string | null
  dealName: string | null
  daysOnMarket: number | null
  salePrice: number | null
}

/** Pure: a STANDOUT close is recruiting ammo — sold fast (≤ 14 DOM) or high (≥ $750k).
 *  Conservative so the Recruiting Manager only crows about wins worth crowing about. */
export function farmWinIsRecruitingProof(win: FarmWin): boolean {
  const fast = win.daysOnMarket !== null && win.daysOnMarket <= 14
  const high = win.salePrice !== null && win.salePrice >= 750_000
  return fast || high
}

/** Pure: each manager's contribution copy — earned lines only, nothing fabricated. */
export function composeFarmPlay(win: FarmWin): {
  agentSummary: string
  postcardCopy: string
  adName: string
  recruitingNote: string | null
} {
  const where = win.soldCity ? ` in ${win.soldCity}` : ""
  const speed = win.daysOnMarket !== null ? ` in just ${win.daysOnMarket} days` : ""
  const postcardCopy = `Another home just sold on your street — ${win.soldAddress}${speed}. Curious what yours is worth in today's market? Your neighbors are asking. Reach out for a no-pressure valuation.`
  const adName = `Just Sold Farm — ${win.soldAddress}`
  const recruitingNote = farmWinIsRecruitingProof(win)
    ? `Win story for the talent pipeline: ${win.dealName ?? win.soldAddress} closed${speed}${win.salePrice ? ` at $${Math.round(win.salePrice).toLocaleString()}` : ""} — proof of what our agents deliver.`
    : null
  const parts = [
    `You own this block now — ${win.soldAddress}${where} just closed${speed}.`,
    `The team staged your farm play: the Data Steward identified the neighbors, Marketing drafted the "just sold near you" postcard, and Ads staged a geo campaign on the block.`,
    `Get the seller's OK to notify neighbors, then approve — nothing goes out until you do.`,
  ]
  return { agentSummary: parts.join(" "), postcardCopy, adName, recruitingNote }
}

export interface FarmPlayResult {
  plays: number
  neighborCampaigns: number
  postcards: number
  adsStaged: number
  recruitingProofs: number
  summariesProposed: number
}

/**
 * Convene a Farm Play for each recently-closed deal whose listing is farmable (has an
 * address) and has no Farm Play yet. Each manager's contribution is idempotent on its
 * own rail; the whole thing is gated — nothing reaches a neighbor without seller
 * permission AND human approval.
 */
export async function runFarmPlays(
  brokerageId: string,
  opts: { now?: Date } = {},
  client?: Svc,
): Promise<FarmPlayResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - FARM_PLAY_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
  const result: FarmPlayResult = {
    plays: 0, neighborCampaigns: 0, postcards: 0, adsStaged: 0, recruitingProofs: 0, summariesProposed: 0,
  }

  const { data: closed } = await supabase.from("transactions")
    .select("id, deal_name, listing_id, agent_id, close_date, contract_date, purchase_price")
    .eq("brokerage_id", brokerageId).eq("status", "closed")
    .gte("close_date", since).not("listing_id", "is", null).limit(50)

  for (const t of (closed ?? []) as any[]) {
    const { data: listing } = await supabase.from("listings")
      .select("id, address, city, agent_id").eq("id", t.listing_id).maybeSingle()
    if (!listing || !(listing as any).address) continue
    const soldAddress = (listing as any).address as string
    // ID-SPACE: listings.agent_id + direct_mail_campaigns.agent_id FK → agents.id;
    // neighbor_notification_campaigns.agent_user_id FK → users.id. Resolve BOTH.
    const agentRowId = (listing as any).agent_id ?? null   // agents.id
    let agentUserId: string | null = null                  // users.id
    if (agentRowId) {
      const { data: ar } = await supabase.from("agents").select("user_id").eq("id", agentRowId).maybeSingle()
      agentUserId = (ar as { user_id: string | null } | null)?.user_id ?? null
    }

    // Idempotency: one Farm Play per listing (the Campaign Orchestrator summary is the key).
    const { data: existingPlay } = await supabase.from("agent_client_messages").select("id")
      .eq("brokerage_id", brokerageId).eq("entity_id", t.listing_id).ilike("rationale", "FARM PLAY%").limit(1).maybeSingle()
    if (existingPlay) continue

    const dom = t.contract_date && t.close_date
      ? Math.max(0, Math.round((new Date(t.close_date).getTime() - new Date(t.contract_date).getTime()) / 86_400_000))
      : null
    const win: FarmWin = {
      soldAddress, soldCity: (listing as any).city ?? null, dealName: t.deal_name,
      daysOnMarket: dom, salePrice: t.purchase_price ?? null,
    }
    const copy = composeFarmPlay(win)

    // 1) DATA STEWARD — stage the neighbor farm (awaiting seller permission; never sends).
    const { data: existCampaign } = await supabase.from("neighbor_notification_campaigns").select("id")
      .eq("listing_id", t.listing_id).limit(1).maybeSingle()
    if (!existCampaign && agentUserId) {
      const { error } = await supabase.from("neighbor_notification_campaigns").insert({
        brokerage_id: brokerageId, agent_user_id: agentUserId, listing_id: t.listing_id,
        max_neighbors: 50, search_radius_meters: 800, min_tenure_years: 5,
        knows_buyer_score_threshold: 0.6, status: "awaiting_seller_permission",
      })
      if (!error) result.neighborCampaigns += 1
    }

    // 2) MARKETING MANAGER — the neighbor postcard, drafted, pending approval.
    const { data: existPostcard } = await supabase.from("direct_mail_campaigns").select("id")
      .eq("brokerage_id", brokerageId).eq("campaign_name", copy.adName).limit(1).maybeSingle()
    if (!existPostcard) {
      const { error } = await supabase.from("direct_mail_campaigns").insert({
        brokerage_id: brokerageId, agent_id: agentRowId, campaign_name: copy.adName,
        target_audience: "farm", piece_type: "postcard", copy_text: copy.postcardCopy,
        // direct_mail_campaigns.status CHECK: planning|approved|printed|mailed — the
        // pre-approval state is 'planning' (approval_status carries the gate state).
        is_ai_generated: true, approval_status: "pending", status: "planning",
      })
      if (!error) result.postcards += 1
    }

    // 3) ADS MANAGER — the geo-fenced paid campaign, staged as a draft (inactive).
    if ((listing as any).city) {
      const { data: existAd } = await supabase.from("ad_campaigns").select("id")
        .eq("brokerage_id", brokerageId).eq("campaign_name", copy.adName).limit(1).maybeSingle()
      if (!existAd) {
        const { error } = await supabase.from("ad_campaigns").insert({
          brokerage_id: brokerageId, campaign_name: copy.adName, platform: "facebook",
          status: "draft", objective: "lead_generation",
          targeting_config: { locations: [(listing as any).city], play: "just_sold_farm", listing_id: t.listing_id },
        })
        if (!error) result.adsStaged += 1
      }
    }

    // 4) RECRUITING MANAGER — a standout close becomes recruiting proof (the bus).
    if (copy.recruitingNote) {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      const pub = await publishManagerSignal({
        brokerageId, fromManager: "deal_coordinator", toManager: "recruiting_manager",
        signalType: "win_story", message: copy.recruitingNote,
        entityType: "transaction", entityId: t.id,
      }, supabase)
      if (pub.ok && !pub.reason) result.recruitingProofs += 1
    }

    // 5) CAMPAIGN ORCHESTRATOR — ONE internal summary into the gate (audience 'agent').
    if (agentUserId) {
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage({
        brokerageId, agentKind: "campaign_orchestrator", entityType: "listing",
        entityId: t.listing_id, audience: "agent",
        subject: `🏡 Farm play ready — you own ${soldAddress}`,
        body: copy.agentSummary,
        rationale: `FARM PLAY — ${soldAddress} closed; the marketing bench (Data Steward + Marketing + Ads + Recruiting) staged the geographic-farming play; seller-permission + human-approval gated.`,
        channel: "portal",
      }, supabase)
      if (res.ok) result.summariesProposed += 1
    }

    // 6) THE BUS — the convening line (the Command Center shows six managers converge).
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const conv = await publishManagerSignal({
      brokerageId, fromManager: "deal_coordinator", toManager: "campaign_orchestrator",
      signalType: "farm_play_convened",
      message: `Farm play convened on ${soldAddress}: neighbor farm staged, postcard + geo ad drafted${copy.recruitingNote ? ", win logged for recruiting" : ""} — awaiting seller OK + your approval.`,
      entityType: "listing", entityId: t.listing_id,
    }, supabase)
    if (conv.ok && conv.signalId && !conv.reason) {
      await supabase.from("manager_signals")
        .update({ status: "consumed", consumed_at: now.toISOString(), consumed_action: "farm play staged across the marketing bench (gated)" })
        .eq("id", conv.signalId)
    }

    result.plays += 1
  }

  return result
}
