// lib/kernel/intent-campaign.ts
//
// THE INTENT CAMPAIGN — the Data Steward leads the outbound growth engine. Instead of
// blasting a generic farm, the Steward SCRAPES who's actually about to move and the
// bench writes to their SITUATION:
//
//   · SELLERS — BatchData motivated-seller signals (high-equity / pre-foreclosure /
//     absentee / vacant) in the brokerage's active markets → a situation-specific
//     direct-mail + email ("homes like yours in {area} with {situation} are selling
//     fast — here's what yours could fetch")
//   · BUYERS — the brokerage's own high-intent buyer contacts (intent_score hot, active
//     recently) → an email to their search ("still looking in {area}? new matches this
//     week, here's what's moving")
//   · Campaign Orchestrator proposes ONE agent summary tying it together.
//
// The seller scrape is an injectable seam (real BatchData in prod; no spend in tests).
// Everything lands gated in its channel; nothing sends. NOT server-only.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** Injectable seam: how many motivated sellers in this market + a sample. */
export type SellerScraper = (params: { city: string; state: string | null; motivationTypes: string[] })
  => Promise<{ recordsFound: number }>

export const realSellerScraper: SellerScraper = async (params) => {
  const { fetchMotivatedSellers } = await import("@/lib/external/batchdata-client")
  const r = await fetchMotivatedSellers({
    state: params.state ?? "", city: params.city, motivationTypes: params.motivationTypes,
  }).catch(() => ({ recordsFound: 0 }))
  return { recordsFound: (r as { recordsFound?: number }).recordsFound ?? 0 }
}

/** Below this intent_score a buyer is not "showing intent" enough for outbound. */
export const BUYER_INTENT_THRESHOLD = 70

/** Pure: the seller situation copy — names the area + the motivation, no fabrication. */
export function composeSellerIntent(area: string, count: number, motivationTypes: string[]): { subject: string; body: string } {
  const sit = motivationTypes.includes("high_equity") ? "with strong equity"
    : motivationTypes.includes("absentee") ? "owned by out-of-area landlords"
    : "in changing circumstances"
  return {
    subject: `${count} homes in ${area} like yours are moving`,
    body: `We're tracking ${count} homes in ${area} ${sit} that are positioned to sell well right now. If you've thought about what yours could fetch in today's market, we'll put together a no-pressure valuation and a plan — no obligation.`,
  }
}

/** Pure: the buyer intent copy — speaks to an active searcher. */
export function composeBuyerIntent(area: string | null, count: number): { subject: string; body: string } {
  return {
    subject: `Still looking${area ? ` in ${area}` : ""}? Here's what's moving`,
    body: `You've been active in your search lately, so here's a quick pulse: ${count > 0 ? `${count} new or improved matches` : "fresh inventory"} just came up${area ? ` around ${area}` : ""}. Reply and I'll line up private tours on the ones worth your time.`,
  }
}

export interface IntentCampaignResult {
  markets: number
  sellersFound: number
  sellerChannels: number
  buyerSegments: number
  buyerChannels: number
  summariesProposed: number
}

const DEFAULT_MOTIVATIONS = ["high_equity", "absentee", "pre_foreclosure"]

/**
 * One intent-campaign pass for a brokerage: scrape motivated sellers in active markets +
 * find high-intent buyers, stage situation-specific multi-channel drafts (gated), and
 * propose one agent summary. Idempotent per market per week (campaign_name keyed).
 */
export async function runIntentCampaign(
  brokerageId: string,
  opts: { now?: Date; sellerScraper?: SellerScraper; maxMarkets?: number } = {},
  client?: Svc,
): Promise<IntentCampaignResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const scraper = opts.sellerScraper ?? realSellerScraper
  const maxMarkets = opts.maxMarkets ?? 2
  const result: IntentCampaignResult = {
    markets: 0, sellersFound: 0, sellerChannels: 0, buyerSegments: 0, buyerChannels: 0, summariesProposed: 0,
  }
  const weekStamp = now.toISOString().slice(0, 10)
  const { stageBenchDrafts } = await import("@/lib/kernel/marketing-bench")

  // A representative agent for the bench rows (brokerage-level campaign).
  const { data: anyAgent } = await supabase.from("agents").select("id, user_id")
    .eq("brokerage_id", brokerageId).not("user_id", "is", null).limit(1).maybeSingle()
  const agentRowId = (anyAgent as any)?.id ?? null
  const agentUserId = (anyAgent as any)?.user_id ?? null

  // The brokerage's active markets — distinct cities/states from active listings.
  const { data: listings } = await supabase.from("listings")
    .select("city, state").eq("brokerage_id", brokerageId).in("status", ["active", "coming_soon"]).limit(500)
  const markets = Array.from(new Map(((listings ?? []) as any[])
    .filter((l) => l.city).map((l) => [String(l.city).toLowerCase(), { city: l.city as string, state: (l.state ?? null) as string | null }])).values()).slice(0, maxMarkets)

  // ── SELLER side: scrape motivated sellers per market → situation-specific drafts. ──
  for (const m of markets) {
    result.markets += 1
    const found = await scraper({ city: m.city, state: m.state, motivationTypes: DEFAULT_MOTIVATIONS }).catch(() => ({ recordsFound: 0 }))
    if (found.recordsFound <= 0) continue
    result.sellersFound += found.recordsFound
    const copy = composeSellerIntent(m.city, found.recordsFound, DEFAULT_MOTIVATIONS)
    const b = await stageBenchDrafts({ brokerageId, agentRowId, agentUserId, listingId: null }, [
      { channel: "direct_mail", idemName: `Intent Sellers ${m.city} ${weekStamp}`, subject: copy.subject, body: copy.body, mailAudience: "motivated_sellers", brief: `INTENT CAMPAIGN — ${found.recordsFound} motivated sellers scraped in ${m.city}` },
      { channel: "email", idemName: `Intent Sellers Email ${m.city} ${weekStamp}`, subject: copy.subject, body: copy.body, brief: `INTENT CAMPAIGN — motivated sellers in ${m.city}` },
    ], supabase)
    result.sellerChannels += b.staged.length
  }

  // ── BUYER side: the brokerage's own high-intent buyers → an email to their search. ──
  const { data: buyers } = await supabase.from("contacts")
    .select("id, buyer_stage, intent_score, updated_at, nurture_status").eq("brokerage_id", brokerageId)
    .eq("contact_type", "buyer").gte("intent_score", BUYER_INTENT_THRESHOLD)
    .gte("updated_at", new Date(now.getTime() - 30 * 86_400_000).toISOString()).limit(500)
  const hotBuyers = ((buyers ?? []) as any[]).filter((b) => b.nurture_status !== "withdrawn")
  if (hotBuyers.length > 0) {
    result.buyerSegments += 1
    const area = markets[0]?.city ?? null
    const copy = composeBuyerIntent(area, hotBuyers.length)
    const b = await stageBenchDrafts({ brokerageId, agentRowId, agentUserId, listingId: null }, [
      { channel: "email", idemName: `Intent Buyers ${area ?? "all"} ${weekStamp}`, subject: copy.subject, body: copy.body, brief: `INTENT CAMPAIGN — ${hotBuyers.length} high-intent buyers (score ≥ ${BUYER_INTENT_THRESHOLD})` },
    ], supabase)
    result.buyerChannels += b.staged.length
  }

  // ── Campaign Orchestrator: one agent summary into the gate. ──
  if ((result.sellerChannels + result.buyerChannels) > 0 && agentUserId) {
    const { data: existing } = await supabase.from("agent_client_messages").select("id")
      .eq("brokerage_id", brokerageId).ilike("rationale", "INTENT CAMPAIGN%")
      .gte("proposed_at", new Date(now.getTime() - 6 * 86_400_000).toISOString()).limit(1).maybeSingle()
    if (!existing) {
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage({
        brokerageId, agentKind: "data_steward", entityType: "contact", audience: "agent",
        subject: `🎯 Intent campaign staged — ${result.sellersFound} motivated sellers, ${hotBuyers.length} hot buyers`,
        body: `The Data Steward scraped your markets: ${result.sellersFound} motivated-seller signals across ${result.markets} area${result.markets === 1 ? "" : "s"} and ${hotBuyers.length} of your own buyers showing fresh intent. Situation-specific email + direct mail are drafted across the channels — review and approve.`,
        rationale: `INTENT CAMPAIGN — Data Steward scraped motivated sellers + high-intent buyers; Marketing staged situation-specific multi-channel drafts; all gated.`,
        channel: "portal",
      }, supabase)
      if (res.ok) result.summariesProposed += 1
    }
  }

  return result
}
