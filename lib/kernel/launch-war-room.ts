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
//
// THE SELLER IS IN THE ROOM TOO — a launch the seller never hears about is a launch that
// didn't happen, as far as they know. When the listing has a linked seller contact
// (seller_contact_id ?? contact_id), the war room ALSO:
//   (a) pushes an AUTONOMOUS portal value card (the tour-recap idiom, transparency_updates)
//       listing the REAL artifacts staged THIS run — never invented, honesty over noise; and
//   (b) PROPOSES a warm agent-voiced launch summary through the client-message gate
//       (audience 'seller', channel 'portal', AI-authored via generateClientMessage with the
//       deterministic composeSellerLaunch copy as the fallback floor). Approval-first.
// Both ride the war room's own once-per-listing guard for idempotency.

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
    agentSummary: `Launch war room is staged for ${address}${where}: the coming-soon reel, a QR-coded "be first to see it" capture page, social + email + newsletter + blog drafts, an open-house draft to date, a neighbor "coming soon" farm, and a geo ad — all waiting on your approval. Set your open-house date and approve to launch in one review.`,
  }
}

/** What THIS run actually staged for one listing — the only facts the seller card may state. */
export interface StagedLaunchArtifacts {
  reelQueued: boolean
  capturePage: boolean
  channels: number
  openHouseProposed: boolean
  neighborFarm: boolean
  geoAd: boolean
}

/**
 * Pure: the seller-facing launch card — title + summary built ONLY from what the run
 * really staged (empty `lines` = nothing real to say = no card). Also the deterministic
 * fallback floor for the AI-authored gated proposal.
 */
export function composeSellerLaunch(
  address: string,
  comingSoon: boolean,
  a: StagedLaunchArtifacts,
): { title: string; summary: string; lines: string[] } {
  const lines: string[] = []
  if (a.reelQueued) lines.push("a launch video reel is in production")
  if (a.capturePage) lines.push('a QR-coded "be first to see it" page is ready for curious buyers')
  if (a.channels > 0) lines.push(`${a.channels} marketing draft${a.channels === 1 ? "" : "s"} across social, email, newsletter and blog are written`)
  if (a.openHouseProposed) lines.push("an open-house plan is drafted (your agent picks the date)")
  if (a.neighborFarm) lines.push("a neighborhood announcement campaign is prepared")
  if (a.geoAd) lines.push("a local ad campaign is drafted")
  const title = comingSoon
    ? `Your launch is underway — here's what your team staged today`
    : `Your listing is live — here's what your team staged today`
  const summary =
    `Your team convened a launch war room for ${address} today: ` +
    lines.join("; ") +
    `. Nothing goes public until your agent reviews and approves each piece.`
  return { title, summary, lines }
}

export interface LaunchResult {
  launches: number
  reels: number
  /** QR-coded listing capture pages (lead_capture_forms + qr_codes), scored by the playbook scoreboard. */
  capturePagesStaged: number
  channelsStaged: number
  /** Open houses are PROPOSED (a draft with no date) — never auto-scheduled, because
   *  the system can't know the agent's chosen date. */
  openHousesProposed: number
  neighborFarms: number
  adsStaged: number
  summariesProposed: number
  /** Autonomous "your listing launched" portal value cards pushed to linked sellers. */
  sellerLaunchCards: number
  /** Gated (audience 'seller') warm launch summaries proposed through the client-message gate. */
  sellerLaunchProposals: number
}

/**
 * Convene a Launch War Room for each active/coming-soon listing with no war room yet.
 * Everything gated; idempotent per listing (the agent summary is the key).
 */
export async function runLaunchWarRoom(
  brokerageId: string,
  opts: { now?: Date; scraper?: NeighborScraper; promoDispatcher?: PromoDispatcher; copyGenerator?: import("@/lib/kernel/ai-copy").CopyGenerator; onlyListingId?: string } = {},
  client?: Svc,
): Promise<LaunchResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const result: LaunchResult = {
    launches: 0, reels: 0, capturePagesStaged: 0, channelsStaged: 0, openHousesProposed: 0, neighborFarms: 0, adsStaged: 0, summariesProposed: 0,
    sellerLaunchCards: 0, sellerLaunchProposals: 0,
  }

  // onlyListingId → the ON-DEMAND path (the Deal Play convenes the room for ONE
  // listing from its detail page); default remains the brokerage-wide sweep.
  let q = supabase.from("listings")
    .select("id, address, city, status, agent_id, seller_contact_id, contact_id, created_at").eq("brokerage_id", brokerageId)
    .in("status", ["coming_soon", "active"]).order("created_at", { ascending: false }).limit(50)
  if (opts.onlyListingId) q = q.eq("id", opts.onlyListingId)
  const { data: listings } = await q

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
    // What THIS run actually stages for THIS listing — the only facts the seller card may state.
    const staged: StagedLaunchArtifacts = {
      reelQueued: false, capturePage: false, channels: 0, openHouseProposed: false, neighborFarm: false, geoAd: false,
    }

    // 1) ASSET — the launch reel (canonical rail; injectable dispatcher for tests).
    if (agentUserId) {
      const dispatcher: PromoDispatcher = opts.promoDispatcher ?? (async (d) => {
        const { dispatchListingPromoVideo } = await import("@/lib/video/listing-promo-reactor")
        const r = await dispatchListingPromoVideo({ ...d, eventType: d.eventType })
        return { ok: r.ok, status: r.status, reason: r.reason }
      })
      const rr = await dispatcher({ brokerageId, listingId: l.id, agentUserId, eventType: comingSoon ? "coming_soon" : "just_listed", bypassPolicy: false })
      if (rr.ok && rr.status !== "skipped") { result.reels += 1; staged.reelQueued = true }
    }

    // 1.5) CAPTURE — the QR-coded "be first to see it" landing for THIS listing.
    // Rides the canonical lead-magnet kernel (createLeadMagnet → publishLeadMagnet
    // mints the tracked QR + lifecycle event); landing copy is AI-authored per
    // listing (generatePersonaCopy; composeLaunch facts are the deterministic
    // fallback — same authoring contract as the bench lane below). The
    // landing_content playbookKey tag is what puts this launch on the SAME
    // outcome scoreboard as the strategy playbooks (qr scan/lead ledgers).
    if (agentRowId && agentUserId) {
      const { createLeadMagnet, publishLeadMagnet } = await import("@/lib/kernel/lead-magnets")
      const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
      const persona = { audience: "buyer", situation: comingSoon ? "watching for new inventory" : "actively shopping" }
      const facts = [`${comingSoon ? "Coming soon" : "Just listed"}: ${l.address}${l.city ? ` in ${l.city}` : ""}`, "Sign up to preview it before the open market"]
      const [head, desc] = await Promise.all([
        generatePersonaCopy({ goal: "a listing capture-page hero headline", facts, channel: "landing", persona, words: 12 }, { body: `Be the first inside ${l.address}` }, { generator: opts.copyGenerator }),
        generatePersonaCopy({ goal: "two sentences of listing capture-page intro copy", facts, channel: "landing", persona, words: 45 }, { body: `${comingSoon ? "Coming soon" : "Just listed"}${l.city ? ` in ${l.city}` : ""}: ${l.address}. Leave your details for a private preview before it hits the open market.` }, { generator: opts.copyGenerator }),
      ])
      const magnet = await createLeadMagnet({
        title: `First look — ${l.address}`,
        description: desc.body,
        magnetType: "listing_alert",
        brokerageId, agentId: agentRowId, createdBy: agentRowId,
        thankYouMessage: "You're on the list — expect a private-preview invitation shortly.",
      })
      if (magnet.success && magnet.magnetId) {
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
        const pub = baseUrl
          ? await publishLeadMagnet({ magnetId: magnet.magnetId, brokerageId, baseUrl, channels: ["qr_code"], actorUserId: agentUserId })
          : { success: false as const }
        const { data: magnetRow } = await supabase
          .from("lead_capture_forms").select("landing_content").eq("id", magnet.magnetId).maybeSingle()
        await supabase.from("lead_capture_forms").update({
          landing_content: {
            ...(((magnetRow as any)?.landing_content as Record<string, unknown>) ?? {}),
            headline: head.body,
            subhead: desc.body,
            playbookKey: "listing_launch",
            listingId: l.id,
            qrCodeId: (pub as any)?.qrCodeId ?? null,
            installedAt: now.toISOString(),
          },
        }).eq("id", magnet.magnetId)
        result.capturePagesStaged += 1
        staged.capturePage = true
      }
    }

    // 2) THE BENCH — social + email + newsletter + blog, copy GENERATED per channel
    // to the buyer audience (composeLaunch is the deterministic fallback).
    if (agentRowId || agentUserId) {
      const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
      const facts = [`${comingSoon ? "Coming soon" : "Just listed"}: ${l.address}${l.city ? ` in ${l.city}` : ""}`, "Private previews and showings are available on request"]
      const persona = { audience: "buyer", situation: comingSoon ? "watching for new inventory" : "actively shopping" }
      const gen = (goal: string, channel: string, fb: string) => generatePersonaCopy({ goal, facts, channel, persona, words: channel === "blog" ? 120 : 50 }, { body: fb }, { generator: opts.copyGenerator })
      const [soc, em, nl, bl] = await Promise.all([
        gen(`a ${comingSoon ? "coming-soon" : "just-listed"} social post`, "social", copy.social),
        gen("a new-listing announcement email", "email", copy.email),
        gen("a newsletter listing feature", "newsletter", copy.newsletter),
        gen("a listing blog post", "blog", copy.blog),
      ])
      const { stageBenchDrafts } = await import("@/lib/kernel/marketing-bench")
      const b = await stageBenchDrafts({ brokerageId, agentRowId, agentUserId, listingId: l.id }, [
        { channel: "social", idemName: `Launch Social — ${l.address}`, subject: "", body: soc.body, socialPostType: comingSoon ? "coming_soon" : "new_listing", brief: "LAUNCH WAR ROOM — launch social" },
        { channel: "email", idemName: `Launch Email — ${l.address}`, subject: `${comingSoon ? "Coming soon" : "Just listed"} — ${l.address}`, body: em.body, brief: "LAUNCH WAR ROOM — launch email" },
        { channel: "newsletter", idemName: `Launch Newsletter — ${l.address}`, subject: `New${comingSoon ? " coming-soon" : ""} listing — ${l.address}`, body: nl.body, brief: "LAUNCH WAR ROOM — newsletter feature" },
        { channel: "blog", idemName: `Introducing ${l.address}`, subject: `A closer look at ${l.address}`, body: bl.body, brief: "LAUNCH WAR ROOM — listing blog" },
      ], supabase)
      result.channelsStaged += b.staged.length
      staged.channels = b.staged.length
    }

    // 3) LISTING CONCIERGE — PROPOSE the first open house as a DRAFT (no date). The
    // system can't know the agent's chosen date, so it stages a placeholder for the
    // agent to date + publish — never a fabricated event_date.
    if (agentRowId) {
      const { data: existOH } = await supabase.from("open_houses").select("id").eq("listing_id", l.id).limit(1).maybeSingle()
      if (!existOH) {
        const { error } = await supabase.from("open_houses").insert({
          brokerage_id: brokerageId, listing_id: l.id, agent_id: agentRowId,
          title: `Open House — ${l.address} (set a date)`, property_address: l.address,
          status: "draft", is_published: false, require_rsvp: true, allow_walkins: true,
        })
        if (!error) { result.openHousesProposed += 1; staged.openHouseProposed = true }
      }
    }

    // 4) DATA STEWARD — the "coming soon" neighbor farm (scrape, seller-permission-gated).
    if (agentUserId) {
      const { stageNeighborFarm } = await import("@/lib/kernel/neighbor-farm")
      const farm = await stageNeighborFarm(brokerageId, l.id, agentUserId, { scraper: opts.scraper }, supabase)
      if (farm.created) { result.neighborFarms += 1; staged.neighborFarm = true }
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
        if (!error) { result.adsStaged += 1; staged.geoAd = true }
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

    // 7) THE SELLER LAUNCH MOMENT — the client this launch is FOR hears about it.
    // (a) AUTONOMOUS portal value card (tour-recap idiom → transparency_updates): the
    //     REAL artifacts this run staged, nothing invented. Idempotent via the war
    //     room's once-per-listing guard above + the card's own dedupe window.
    // (b) GATED warm launch summary through the client-message gate (audience 'seller',
    //     channel 'portal') — AI-authored in the agent's brand voice (generateClientMessage,
    //     the canonical Wave-58 idiom), with the deterministic card copy as the floor.
    const sellerContactId: string | null = l.seller_contact_id ?? l.contact_id ?? null
    if (sellerContactId) {
      const sellerCopy = composeSellerLaunch(l.address, comingSoon, staged)
      if (sellerCopy.lines.length > 0) {
        try {
          const { pushPortalValueCard } = await import("@/lib/kernel/portal-value")
          const card = await pushPortalValueCard({
            brokerageId, contactId: sellerContactId, listingId: l.id,
            title: sellerCopy.title, summary: sellerCopy.summary,
            updateType: "listing_launch_seller", now,
            metadata: {
              listing_id: l.id, coming_soon: comingSoon, staged: { ...staged }, seller_safe: true,
            },
          }, supabase)
          if (card.pushed) result.sellerLaunchCards += 1
        } catch { /* the card must never break the launch itself */ }

        // Deterministic floor; upgraded to brand-voiced AI copy when the gateway is available.
        let subject = `${comingSoon ? "Your launch is underway" : "Your listing is live"} — ${l.address}`
        let body = sellerCopy.summary
        try {
          // Dynamic import: generate-client-message is server-only; in non-Next runtimes
          // (simulators) the import throws and the deterministic floor stands.
          const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
          let sellerFirstName: string | null = null
          const { data: sc } = await supabase.from("contacts").select("first_name").eq("id", sellerContactId).maybeSingle()
          sellerFirstName = (sc as { first_name?: string | null } | null)?.first_name ?? null
          const gen = await generateClientMessage({
            brokerageId, agentUserId, audience: "seller",
            recipientFirstName: sellerFirstName,
            purpose: `Warmly tell your seller that their listing's marketing launch is staged: the whole team convened today and prepared the launch pieces listed in the facts. Make clear that you (their agent) review and approve every piece before anything goes public. Celebratory, reassuring, no pressure.`,
            facts: [
              { label: "Home", value: `${l.address}${l.city ? `, ${l.city}` : ""} (${comingSoon ? "coming soon" : "just listed"})` },
              ...sellerCopy.lines.map((v) => ({ label: "Staged today", value: v })),
            ],
            fallback: { subject, body },
          })
          subject = gen.subject
          body = gen.body
        } catch { /* deterministic floor stands */ }

        const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
        const sellerRes = await proposeClientMessage({
          brokerageId, agentKind: "listing_concierge", entityType: "listing", entityId: l.id,
          recipientContactId: sellerContactId, audience: "seller",
          subject, body,
          rationale: `LAUNCH WAR ROOM — seller launch summary for ${l.address}: the autonomous portal card already lists what was staged; this is the warm agent-voiced version, gated for your review.`,
          channel: "portal",
        }, supabase)
        if (sellerRes.ok) result.sellerLaunchProposals += 1
      }
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
