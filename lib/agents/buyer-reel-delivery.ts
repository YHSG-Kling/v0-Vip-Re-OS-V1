/**
 * lib/agents/buyer-reel-delivery.ts
 *
 * Wave 64 — closes the buyer egress loop. The buyer property-match REEL is rendered in
 * the deliverable-gated render queue; when it finishes, this proposes it to the buyer as
 * a Shopping-Agent-owned client message on the ONE Command Center (channel portal), with
 * the finished video link. So the reel — like every other buyer activity — is governed by
 * the proper manager and human-released before it reaches the client. AI-generated note
 * (brand-voiced, compliance-gated) + neutral fallback. Idempotent per buyer per week.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

type Svc = ReturnType<typeof createServiceClient>

export interface ReelDeliveryResult { proposed: number; reason?: string }

const DELIVERY_COOLDOWN_DAYS = 7

/** Resilience fallback note (the primary copy is AI-generated + brand-voiced). */
export function buildReelDeliveryFallback(agentName: string): { subject: string; body: string } {
  const safeName = sanitizeProperNoun(agentName, 60) ?? "Your Agent"
  return {
    subject: "Your personalized home matches — a quick video",
    body: `I put together a short video of the homes that best fit what you're looking for right now. Take a look when you have a minute, and tell me which ones you'd like to tour — I'll set it up. — ${safeName}`,
  }
}

/**
 * Propose delivery of a finished buyer-match reel to the buyer (Shopping Agent owns it).
 * `render` is a completed remotion_composition_renders row (contact-scoped, output_url set).
 * Idempotent per (buyer, week). Never throws.
 */
export async function proposeBuyerReelDelivery(
  svc: Svc, brokerageId: string,
  render: {
    id: string; entity_id: string | null; agent_user_id: string | null
    output_url: string | null; thumbnail_url?: string | null
    /** Set when this cut replaced a stale one — exempt from the weekly cooldown. */
    refreshed_from_render_id?: string | null
  },
): Promise<ReelDeliveryResult> {
  const contactId = render.entity_id
  if (!brokerageId || !contactId || !render.output_url) return { proposed: 0, reason: "missing contact or video" }

  // ── IDEMPOTENCY, PER VIDEO (m314) ─────────────────────────────────────────
  // This was a per-WEEK guard, which would have swallowed the living refresh
  // exactly the way the seller-update path did: a reel re-rendered because one
  // of its homes went under contract on Tuesday would be skipped until the
  // cooldown lapsed, so the sweep would burn a real render and the buyer would
  // keep the wrong video. The body carries the video URL, so "has this exact
  // cut already been offered?" is answerable and is the right question.
  const { data: sameVideo } = await svc.from("agent_client_messages")
    .select("id").eq("brokerage_id", brokerageId).eq("entity_type", "buyer_match_reel")
    .eq("recipient_contact_id", contactId)
    .ilike("body", `%${render.output_url}%`)
    .limit(1).maybeSingle()
  if (sameVideo) return { proposed: 0, reason: "this exact reel was already proposed" }

  // The cooldown still applies to an ORDINARY reel, so the cadence cannot
  // propose twice in a week. A REFRESH is exempt — it exists because a home the
  // buyer was shown is no longer available, and making them wait for the
  // calendar is the defect this closes.
  if (!render.refreshed_from_render_id) {
    const sinceIso = new Date(Date.now() - DELIVERY_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const { data: existing } = await svc.from("agent_client_messages")
      .select("id").eq("brokerage_id", brokerageId).eq("entity_type", "buyer_match_reel")
      .eq("recipient_contact_id", contactId).gte("proposed_at", sinceIso)
      .in("status", ["proposed", "approved", "sent"]).maybeSingle()
    if (existing) return { proposed: 0, reason: "already delivered this week" }
  }

  const { data: c } = await svc.from("contacts").select("first_name, agent_id, brokerage_id").eq("id", contactId).maybeSingle()
  const contact = c as { first_name: string | null; agent_id: string | null; brokerage_id: string | null } | null
  if (!contact || contact.brokerage_id !== brokerageId) return { proposed: 0, reason: "contact not in brokerage" }

  let agentName = "Your Agent"
  const agentUserId = render.agent_user_id
  if (agentUserId) {
    const { data: u } = await svc.from("users").select("first_name, last_name").eq("id", agentUserId).maybeSingle()
    const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
    if (full) agentName = full
  }

  const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
  const msg = await generateClientMessage({
    brokerageId, agentUserId, audience: "buyer",
    purpose: "Let the buyer know you put together a short personalized video of the homes that best match their search, and invite them to watch it and say which to tour.",
    recipientFirstName: contact.first_name,
    ctas: ["Watch the short video", "Reply with which homes to tour"],
    fallback: buildReelDeliveryFallback(agentName),
  })
  // The finished video is the deliverable — append the link (human reviews before it sends).
  const body = `${msg.body}\n\n▶ Watch your matches: ${render.output_url}`

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const r = await proposeClientMessage({
    brokerageId, agentKind: "shopping_agent", entityType: "buyer_match_reel", entityId: contactId,
    recipientContactId: contactId, audience: "buyer", subject: msg.subject, body,
    rationale: render.refreshed_from_render_id
      ? "REFRESHED property-match reel — a home in the previous cut is no longer available, so this one is the current truth. Review + send."
      : "Personalized property-match reel finished — review + send the video to the buyer.",
    channel: "portal",
  }, svc)
  return { proposed: r.ok ? 1 : 0 }
}

/**
 * Sweep finished buyer-match reels (contact-scoped AffordabilitySnapshotReel renders that
 * succeeded with a video) and propose delivery for each. Idempotent via the per-buyer guard.
 */
export async function deliverFinishedBuyerReels(svc: Svc, limit = 50): Promise<{ delivered: number; scanned: number }> {
  const sinceIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
  const { data: renders } = await svc.from("remotion_composition_renders")
    .select("id, brokerage_id, entity_id, agent_user_id, output_url, thumbnail_url, refreshed_from_render_id")
    .eq("composition_id", "AffordabilitySnapshotReel").eq("entity_type", "contact")
    .eq("render_status", "succeeded").not("output_url", "is", null)
    .gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(limit)
  const rows = (renders ?? []) as Array<{
    id: string; brokerage_id: string; entity_id: string | null; agent_user_id: string | null
    output_url: string | null; thumbnail_url: string | null; refreshed_from_render_id: string | null
  }>
  let delivered = 0
  for (const r of rows) {
    try {
      const res = await proposeBuyerReelDelivery(svc, r.brokerage_id, r)
      delivered += res.proposed
    } catch { /* best-effort per render */ }
  }
  return { delivered, scanned: rows.length }
}
