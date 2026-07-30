// lib/agents/seller-update-reel-producer.ts
//
// LISTING CONCIERGE — weekly SELLER UPDATE VIDEO, governed end-to-end. The seller
// side's analogue of the buyer match reel: instead of a plain text update, the
// Listing Concierge produces a short D-ID avatar talking-head (the agent's cloned
// ElevenLabs voice — NO HeyGen) summarizing the week's showings, buyer interest,
// days-on-market and price position, then PROPOSES it to the seller through the
// client-message deliverable gate. A human approves/edits in the Command Center;
// approving sends it. Nothing reaches the seller autonomously.
//
//   requestSellerUpdateReel ── enqueues AgentTalkingHeadReel (used_did_avatar) ──▶
//     remotion_composition_renders ── D-ID poll cron renders it ──▶ output_url
//       deliverSellerUpdateReels ── proposeClientMessage(audience='seller') ──▶ GATE
//
// Both halves are idempotent, but NOT on the same key (m312). The CADENCE is
// guarded per 7-day window so the scheduled sweep cannot render or propose twice
// in a week. A LIVING REFRESH — a re-render triggered because a fact the seller
// cares about actually moved — is exempt from both windows and instead
// de-duplicates per VIDEO: one proposal per distinct cut. Keying delivery on the
// calendar would have meant the refresh burned a real render every time and the
// seller never saw it, which is the same defect one stage further downstream.
// Pure builders (props + copy) are unit-tested; the producers are live-probed.

import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

export const SELLER_UPDATE_COMPOSITION = "AgentTalkingHeadReel"
/** Tags the render's input_props so delivery can distinguish seller updates from
 *  other AgentTalkingHeadReel renders that share the composition. */
export const SELLER_UPDATE_KIND = "seller_weekly_update"
/** Distinct entity_type for the gated VIDEO seller-update message — so it (a) doesn't share an
 *  idempotency window with the separate TEXT seller-update (both were entity_type='listing',
 *  silently de-duping each other) and (b) lets approval materialize the rich seller_updates card. */
export const SELLER_UPDATE_ENTITY_TYPE = "seller_update_video"

export interface SellerUpdateStats {
  listingAddress: string
  showingsThisWeek: number
  /** Coarse interest label derived from completed-showing buyer_interest_level. */
  interestLabel: "strong" | "moderate" | "light" | "none"
  daysOnMarket: number | null
  listPrice: number | null
  /** THE SCAN CURVE — total tracked-QR scans across this listing's videos
   *  (qr_codes.scan_count, listing-scoped). The receipt no competitor can
   *  show a seller: what the video campaign actually DID. */
  videoScans?: number
}

/** Pure: coarse interest label from completed-showing interest levels. */
export function interestLabelFor(levels: Array<string | null>): SellerUpdateStats["interestLabel"] {
  const interested = levels.filter((l) => l === "interested" || l === "very_interested").length
  if (levels.length === 0) return "none"
  const ratio = interested / levels.length
  if (ratio >= 0.5) return "strong"
  if (ratio >= 0.2) return "moderate"
  return "light"
}

/** Pure: the talking-head avatar props (what the agent's avatar "says" on screen). */
export function buildSellerUpdateReelProps(
  stats: SellerUpdateStats,
  identity: { agentName: string; brokerageName: string; agentPhone?: string; agentPhotoUrl?: string | null },
): Record<string, unknown> {
  const safeAgent = sanitizeProperNoun(identity.agentName, 60) ?? "Your Agent"
  const showingLine = stats.showingsThisWeek === 0
    ? "No showings this week — let's talk about positioning."
    : `${stats.showingsThisWeek} showing${stats.showingsThisWeek === 1 ? "" : "s"} this week with ${stats.interestLabel} buyer interest.`
  return {
    kind: SELLER_UPDATE_KIND,
    hook: "WEEKLY UPDATE",
    agentName: safeAgent,
    caption: showingLine.slice(0, 90),
    ctaLabel: "Review the full update",
    avatarVideoUrl: null,   // filled by the D-ID render pipeline
    agentPhotoUrl: identity.agentPhotoUrl ?? null,
    brand: {
      primaryColor: "#0F172A",
      accentColor: "#F59E0B",
      brokerageName: sanitizeProperNoun(identity.brokerageName, 80) ?? "Your Brokerage",
      agentPhone: identity.agentPhone ?? "",
      showEhoMark: true,
    },
  }
}

/** Pure: the seller-safe message copy that carries the video into the gate. */
export function buildSellerUpdateMessage(
  stats: SellerUpdateStats,
  agentName: string,
  videoUrl?: string | null,
): { subject: string; body: string } {
  const safeName = sanitizeProperNoun(agentName, 60) ?? "Your Agent"
  const dom = stats.daysOnMarket != null ? `${stats.daysOnMarket} days on market` : "freshly listed"
  const showings = stats.showingsThisWeek === 0
    ? "We had a quieter week on showings"
    : `We had ${stats.showingsThisWeek} showing${stats.showingsThisWeek === 1 ? "" : "s"} this week (${stats.interestLabel} buyer interest)`
  const lines = [
    `Here's your weekly update on ${stats.listingAddress}.`,
    `${showings}, and we're at ${dom}.`,
    (stats.videoScans ?? 0) > 0 ? `Your marketing videos have driven ${stats.videoScans} QR scan${stats.videoScans === 1 ? "" : "s"} from interested buyers so far.` : "",
    videoUrl ? `I recorded a short video walking you through it: ${videoUrl}` : "",
    `I'll follow up with next-step recommendations. — ${safeName}`,
  ].filter(Boolean)
  return { subject: `Your weekly update — ${stats.listingAddress}`, body: lines.join("\n\n") }
}

type Svc = ReturnType<typeof createServiceClient>

async function gatherSellerUpdateStats(supabase: Svc, brokerageId: string, listingId: string): Promise<{
  stats: SellerUpdateStats; sellerContactId: string | null; agentId: string | null
} | null> {
  const { data: listing } = await supabase
    .from("listings")
    .select("id, address, list_price, go_live_date, seller_contact_id, agent_id")
    .eq("id", listingId).eq("brokerage_id", brokerageId).maybeSingle()
  const l = listing as {
    address: string | null; list_price: number | null; go_live_date: string | null
    seller_contact_id: string | null; agent_id: string | null
  } | null
  if (!l) return null

  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { data: showings } = await supabase
    .from("showings")
    .select("buyer_interest_level")
    .eq("listing_id", listingId).eq("status", "completed").gte("scheduled_at", weekAgo)
  const levels = ((showings ?? []) as Array<{ buyer_interest_level: string | null }>).map((s) => s.buyer_interest_level)

  const { computeDaysOnMarket } = await import("@/lib/listings/compute-dom")
  const dom = computeDaysOnMarket(l.go_live_date)

  // THE SCAN CURVE — every video this listing's campaign shipped carries a
  // tracked QR (qr_codes.listing_id); the summed scan_count is the receipt
  // the seller sees: what the video marketing actually DID.
  let videoScans = 0
  try {
    const { data: qrs } = await supabase.from("qr_codes")
      .select("scan_count").eq("brokerage_id", brokerageId).eq("listing_id", listingId).limit(50)
    videoScans = ((qrs ?? []) as Array<{ scan_count: number | null }>).reduce((a, q) => a + (Number(q.scan_count) || 0), 0)
  } catch { /* scans are additive — never block the update */ }

  return {
    stats: {
      listingAddress: l.address ?? "your listing",
      showingsThisWeek: levels.length,
      interestLabel: interestLabelFor(levels),
      daysOnMarket: dom,
      listPrice: l.list_price,
      videoScans,
    },
    sellerContactId: l.seller_contact_id,
    agentId: l.agent_id,
  }
}

/**
 * THE FACTS this video asserts — read-only, no side effects (no QR minting, no
 * identity lookups, no writes), so the living-video sweep can re-derive them on
 * every tick for pennies and tell whether the delivered video has started saying
 * something untrue.
 *
 * Kept deliberately narrow. The video's input_props also carry a QR data URL, a
 * photo array, and the agent's phone — cosmetics that change for reasons a
 * seller would never call "my video is out of date". Only what is asserted
 * on screen is a fact.
 */
export async function sellerUpdateFacts(
  supabase: Svc, brokerageId: string, listingId: string,
): Promise<import("@/lib/video/living-video").LivingFacts | null> {
  const gathered = await gatherSellerUpdateStats(supabase, brokerageId, listingId)
  if (!gathered) return null

  // The AVATAR is a fact about the video, not a setting beside it: the agent
  // onboards by recording one from a photo or a video, it lands in our storage
  // bucket, and when they re-record it every already-delivered living video is
  // still fronted by the old face until it re-renders.
  let avatarId: string | null = null
  if (gathered.agentId) {
    try {
      const { data: a } = await supabase.from("agents").select("user_id").eq("id", gathered.agentId).maybeSingle()
      const uid = (a as { user_id: string | null } | null)?.user_id ?? null
      if (uid) {
        const { resolveSelfAvatar } = await import("@/lib/voice/voice-resolver")
        avatarId = (await resolveSelfAvatar(uid)).avatarId
      }
    } catch { /* an unresolvable avatar is recorded as null, not as a change */ }
  }

  return {
    listingAddress:    gathered.stats.listingAddress,
    listPrice:         gathered.stats.listPrice,
    showingsThisWeek:  gathered.stats.showingsThisWeek,
    interestLabel:     gathered.stats.interestLabel,
    daysOnMarket:      gathered.stats.daysOnMarket,
    // Optional on the stats type; absent and zero mean the same thing to a
    // seller, and collapsing them here keeps the key stable across the two.
    videoScans:        gathered.stats.videoScans ?? 0,
    avatarId,
  }
}

/**
 * Enqueue a weekly seller-update avatar render for a listing. Idempotent: skips if a
 * seller-update render for this listing was queued/rendered in the last 7 days.
 *
 * `force` exists for the LIVING-VIDEO refresh. The weekly window is a spam guard
 * against the cadence cron, not a rule that the seller must live with a stale
 * number: when the facts have materially moved (a price change on Tuesday), the
 * sweep passes force and the seller gets the true video instead of waiting until
 * Monday for one that opens with the old price.
 */
export async function requestSellerUpdateReel(
  brokerageId: string, listingId: string, client?: Svc,
  opts: { force?: boolean; refreshedFromRenderId?: string | null } = {},
): Promise<{ queued: boolean; renderId?: string; reason?: string }> {
  const supabase = client ?? createServiceClient()
  if (!brokerageId || !listingId) return { queued: false, reason: "missing ids" }

  const gathered = await gatherSellerUpdateStats(supabase, brokerageId, listingId)
  if (!gathered) return { queued: false, reason: "listing not found" }
  if (!gathered.sellerContactId) return { queued: false, reason: "no seller contact on listing" }

  // Idempotency — one seller-update render per listing per week.
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { data: recent } = await supabase
    .from("remotion_composition_renders")
    .select("id, input_props")
    .eq("brokerage_id", brokerageId)
    .eq("composition_id", SELLER_UPDATE_COMPOSITION)
    .eq("entity_type", "contact").eq("entity_id", gathered.sellerContactId)
    .gte("created_at", weekAgo)
  const already = ((recent ?? []) as Array<{ input_props: Record<string, unknown> | null }>)
    .some((r) => (r.input_props as { kind?: string } | null)?.kind === SELLER_UPDATE_KIND
      && (r.input_props as { listing_id?: string } | null)?.listing_id === listingId)
  if (already && !opts.force) return { queued: false, reason: "already queued this week" }

  // Agent + brokerage identity for the avatar card.
  let agentName = "Your Agent", agentPhone = "", agentUserId: string | null = null, agentPhotoUrl: string | null = null
  if (gathered.agentId) {
    const { data: a } = await supabase.from("agents").select("user_id").eq("id", gathered.agentId).maybeSingle()
    agentUserId = (a as { user_id: string | null } | null)?.user_id ?? null
    if (agentUserId) {
      const { data: u } = await supabase.from("users").select("first_name, last_name, phone").eq("id", agentUserId).maybeSingle()
      const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
      if (full) agentName = full
      if ((u as any)?.phone) agentPhone = String((u as any).phone)
    }
  }
  let brokerageName = "Your Brokerage"
  const { data: b } = await supabase.from("brokerages").select("name").eq("id", brokerageId).maybeSingle()
  if ((b as { name?: string } | null)?.name) brokerageName = String((b as { name: string }).name)

  const props: Record<string, unknown> = {
    ...buildSellerUpdateReelProps(gathered.stats, { agentName, brokerageName, agentPhone, agentPhotoUrl }),
    listing_id: listingId,
    seller_contact_id: gathered.sellerContactId,
  }

  // B-ROLL (owner rule: avatar videos carry cutaway footage) — the seller's OWN
  // listing photos behind the floating avatar; the most personal b-roll there is.
  try {
    const { data: lphotos } = await supabase.from("listings").select("photos, primary_photo_url").eq("id", listingId).maybeSingle()
    const photoList = Array.isArray((lphotos as any)?.photos) ? ((lphotos as any).photos as unknown[]) : []
    const urls = [...photoList.map((p: any) => (typeof p === "string" ? p : p?.url)), (lphotos as any)?.primary_photo_url]
      .filter((u): u is string => typeof u === "string" && u.startsWith("http")).slice(0, 5)
    if (urls.length > 0) props.brollClips = urls.map((url) => ({ url }))
  } catch { /* no photos → the solid-brand layout stands */ }

  // TRACKED QR on the outro (owner rule: QR ships on every non-selfie video) —
  // "scan to talk" via the shared tracked-QR core, idempotent per listing.
  try {
    if (agentUserId) {
      const { mintVideoQr } = await import("@/lib/video/video-qr")
      const minted = await mintVideoQr({ brokerageId, agentUserId, kind: "explainer", listingId }, supabase)
      if (minted) { props.qrCodeDataUrl = minted.qrCodeDataUrl; props.qrCaption = "Scan to reach me" }
    }
  } catch { /* QR is additive */ }

  // The LIVING identity: what this video asserts, so the refresh sweep can
  // re-derive the same facts later and diff them.
  const { computeFactsKey, LIVING_KINDS } = await import("@/lib/video/living-video")
  const facts = await sellerUpdateFacts(supabase, brokerageId, listingId)

  const { recordRenderQueued } = await import("@/lib/remotion/registry")
  const r = await recordRenderQueued({
    brokerageId, compositionId: SELLER_UPDATE_COMPOSITION, agentUserId,
    entityType: "contact", entityId: gathered.sellerContactId,
    usedDidAvatar: true, usedVoiceover: true,
    inputProps: props, scopeType: "brokerage", scopeId: brokerageId, requestedVia: "cron",
    livingKind: facts ? LIVING_KINDS.seller_weekly_update.kind : null,
    factsKey: facts ? computeFactsKey(LIVING_KINDS.seller_weekly_update.kind, facts) : null,
    facts: facts ?? null,
    refreshedFromRenderId: opts.refreshedFromRenderId ?? null,
  })
  return r.ok ? { queued: true, renderId: r.renderId } : { queued: false, reason: r.error }
}

/**
 * Sweep finished seller-update renders and PROPOSE each to the seller through the
 * client-message gate (audience='seller', Listing Concierge).
 *
 * ── THE OTHER HALF OF THE LIVING-VIDEO LOOP (m312) ──────────────────────────
 * The refresh sweep re-renders a seller's video when the facts move, and this is
 * where that work either reaches the seller or dies. It nearly died here, in
 * three ways, all fixed below:
 *
 *   1. THE SAME WINDOW, ONE STAGE LATER. Idempotency was "one proposal per
 *      listing per WEEK", so a video re-rendered because the price changed on
 *      Tuesday was silently skipped until the following Monday. Closing the
 *      seven-day window on the render side and leaving it on the delivery side
 *      would have moved the defect, not fixed it — the sweep would burn a real
 *      render every time and the seller would never see it.
 *      Idempotency is now per VIDEO: has THIS output_url already been proposed?
 *      The cadence guard stays for non-refresh renders, so nothing spams.
 *   2. IT PROPOSED AN ARBITRARY CUT. The read took EVERY succeeded seller-update
 *      render with no ordering. The moment a refresh exists there are two for
 *      one listing, and which one got proposed depended on row order — so the
 *      OS could have mailed the seller the SUPERSEDED video. Worse than not
 *      refreshing at all. Now: newest completed cut per (listing, seller).
 *   3. UNBOUNDED. No limit on a table that grows with every render.
 */
export async function deliverSellerUpdateReels(
  brokerageId: string, client?: Svc,
): Promise<{ proposed: number }> {
  const supabase = client ?? createServiceClient()
  if (!brokerageId) return { proposed: 0 }

  const { data: renders } = await supabase
    .from("remotion_composition_renders")
    .select("id, brokerage_id, entity_id, agent_user_id, output_url, input_props, completed_at, refreshed_from_render_id")
    .eq("brokerage_id", brokerageId)
    .eq("composition_id", SELLER_UPDATE_COMPOSITION)
    .eq("render_status", "succeeded").not("output_url", "is", null)
    .order("completed_at", { ascending: false })
    .limit(500)
  type RenderRow = {
    id: string; entity_id: string | null; agent_user_id: string | null
    output_url: string | null; input_props: Record<string, unknown> | null
    completed_at: string | null; refreshed_from_render_id: string | null
  }
  const all = ((renders ?? []) as RenderRow[])
    .filter((r) => (r.input_props as { kind?: string } | null)?.kind === SELLER_UPDATE_KIND)

  // NEWEST cut per (listing, seller). The query is already newest-first, so the
  // first sighting wins — a superseded video is never the one proposed.
  const rows: RenderRow[] = []
  const seen = new Set<string>()
  for (const r of all) {
    const listingId = (r.input_props as { listing_id?: string } | null)?.listing_id ?? null
    if (!listingId || !r.entity_id) continue
    const k = `${listingId}:${r.entity_id}`
    if (seen.has(k)) continue
    seen.add(k)
    rows.push(r)
  }

  let proposed = 0
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")

  for (const r of rows) {
    const listingId = (r.input_props as { listing_id?: string } | null)?.listing_id ?? null
    const sellerContactId = r.entity_id
    if (!listingId || !sellerContactId || !r.output_url) continue

    // Idempotency, per VIDEO. The proposal body embeds the video URL, so "has
    // this exact cut already been offered to this seller?" is answerable without
    // a new column — and it is the right question, because the thing we must not
    // duplicate is a VIDEO, not a calendar week.
    const { data: sameVideo } = await supabase
      .from("agent_client_messages")
      .select("id")
      .eq("brokerage_id", brokerageId).eq("entity_type", SELLER_UPDATE_ENTITY_TYPE).eq("entity_id", listingId)
      .eq("agent_kind", "listing_concierge").eq("audience", "seller")
      .ilike("body", `%${r.output_url}%`)
      .limit(1).maybeSingle()
    if (sameVideo) continue

    // The weekly cadence guard still applies to an ORDINARY render, so the
    // scheduled sweep cannot propose twice in a week. A REFRESH is exempt: it
    // exists precisely because something the seller cares about changed, and
    // making them wait for the calendar is the defect this closes.
    if (!r.refreshed_from_render_id) {
      const { data: recentProposal } = await supabase
        .from("agent_client_messages")
        .select("id")
        .eq("brokerage_id", brokerageId).eq("entity_type", SELLER_UPDATE_ENTITY_TYPE).eq("entity_id", listingId)
        .eq("agent_kind", "listing_concierge").eq("audience", "seller")
        .gte("created_at", weekAgo).limit(1).maybeSingle()
      if (recentProposal) continue
    }

    const gathered = await gatherSellerUpdateStats(supabase, brokerageId, listingId)
    if (!gathered) continue
    let agentName = "Your Agent"
    if (r.agent_user_id) {
      const { data: u } = await supabase.from("users").select("first_name, last_name").eq("id", r.agent_user_id).maybeSingle()
      const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
      if (full) agentName = full
    }
    const msg = buildSellerUpdateMessage(gathered.stats, agentName, r.output_url)
    const res = await proposeClientMessage({
      brokerageId, agentKind: "listing_concierge", entityType: SELLER_UPDATE_ENTITY_TYPE, entityId: listingId,
      recipientContactId: sellerContactId, audience: "seller",
      subject: msg.subject, body: msg.body,
      rationale: r.refreshed_from_render_id
        ? `REFRESHED seller-update video for ${gathered.stats.listingAddress} — the facts changed since the last one, so this cut is the current truth. Review/edit before it reaches the seller.`
        : `Weekly seller-update video for ${gathered.stats.listingAddress} — review/edit before it reaches the seller.`,
      channel: "portal",
    }, supabase)
    if (res.ok) proposed += 1
  }
  return { proposed }
}

/**
 * materializeSellerUpdate — called when a seller_update_video message is APPROVED. Writes the rich
 * seller_updates row (video_url + copy) that the portal's AgentUpdateVideoCard reads, so the
 * agent's avatar update actually SURFACES in the seller's listing dashboard (it never did — nothing
 * wrote this table). Honors the human gate: only fires on approval. Idempotent per (listing, video).
 */
export async function materializeSellerUpdate(
  supabase: Svc,
  input: { brokerageId: string; listingId: string; sellerContactId: string | null; subject: string | null; body: string },
): Promise<{ ok: boolean; reason?: string }> {
  if (!input.sellerContactId) return { ok: false, reason: "no seller contact" }
  // Resolve the latest succeeded seller-update render for this listing (the video the message carries).
  const { data: renders } = await supabase
    .from("remotion_composition_renders")
    .select("output_url, input_props, created_at")
    .eq("brokerage_id", input.brokerageId)
    .eq("composition_id", SELLER_UPDATE_COMPOSITION)
    .eq("entity_id", input.sellerContactId)
    .eq("render_status", "succeeded").not("output_url", "is", null)
    .order("created_at", { ascending: false }).limit(10)
  const render = ((renders ?? []) as Array<{ output_url: string | null; input_props: Record<string, unknown> | null }>)
    .find((r) => (r.input_props as { kind?: string; listing_id?: string } | null)?.kind === SELLER_UPDATE_KIND
      && (r.input_props as { listing_id?: string } | null)?.listing_id === input.listingId)
  if (!render?.output_url) return { ok: false, reason: "no rendered video for this listing" }

  // Idempotent — don't double-insert the same video for this listing.
  const { data: dup } = await supabase.from("seller_updates")
    .select("id").eq("listing_id", input.listingId).eq("video_url", render.output_url).limit(1).maybeSingle()
  if (dup) return { ok: true, reason: "already materialized" }

  const { error } = await supabase.from("seller_updates").insert({
    brokerage_id: input.brokerageId, contact_id: input.sellerContactId, listing_id: input.listingId,
    subject: input.subject, body: input.body, video_url: render.output_url, thumbnail_url: null,
  })
  return error ? { ok: false, reason: error.message } : { ok: true }
}
