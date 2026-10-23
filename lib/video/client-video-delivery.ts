/**
 * lib/video/client-video-delivery.ts — AN APPROVED CLIENT-FACING VIDEO IS DELIVERED (wave 98).
 *
 * Owner, 2026-10-03: "yes should be send to portal if contact and email once approved. other
 * videos should be considered to add to this list." Before this, the AI-ISA's send_explainer_video
 * commissioned a video addressed to NO contact that waited in the approval queue and was never
 * delivered (lane 97C). Now the tool threads the contact onto the row
 * (lib/video/avatar-explainer.ts commissionAvatarExplainer `contactId`), and ONE delivery runs:
 *
 *   · on APPROVAL — lib/kernel/approval-queue-aggregator.ts applyMarketingAssetApproval("video")
 *     (the one canonical release every approval surface rides: cascadeApprove + the marketing
 *     approvals action), and
 *   · on RENDER READY — lib/orchestrator/internal.ts handleVideoGenerated (the in-force video.generated
 *     handler), for a video approved before its render finished (no URL yet at approval).
 *
 * Delivery = ONE portal card (the existing writer, lib/kernel/portal-value.ts pushPortalValueCard,
 * played by RecentUpdatesFeed's CARD_VIDEO_KEYS[CLIENT_VIDEO_UPDATE_TYPE]) + ONE email through the
 * governed chokepoint dispatchEmail (consent / suppression / fatigue / action ledger apply), reason
 * HUMAN_REQUESTED (a human approved it), cycle `video:<id>` — so a re-approval or a second render
 * event REPLAYS the ledger row instead of sending again, and the card is checked per video id.
 * A video with no contact, an in-house video, or a kind not in CLIENT_FACING_VIDEO_TYPES stays in
 * the library — nothing is sent.
 */
import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * THE ONE LIST of video kinds that are FOR a client when they carry a contact (ai_video_projects.
 * video_type, live CHECK vocabulary). Not here, on purpose:
 *   · welcome — delivered by its own rail (lib/kernel/client-welcome.ts writePortalWelcomeCard + the
 *     welcome email); adding it would send twice.
 *   · home_anniversary — delivered by the anniversary sweep (app/api/cron/intro-video-email-backfill).
 *   · just_listed / just_sold / coming_soon / open_house_promo / listing_promo / social_reel /
 *     agent_intro / testimonial / memory_video / presentation_chapter — public marketing or
 *     agent/brokerage material: library only (memory_video's own delivery is the per-contact draft
 *     rail in lib/orchestrator/internal.ts handleVideoGenerated personalVideoTypes — disjoint from this list).
 * `education` is the explainer's pre-m274 fallback spelling (avatar-explainer.ts stores it with
 * video_type_intent 'avatar_explainer' when the CHECK predates the kind).
 */
export const CLIENT_FACING_VIDEO_TYPES = [
  "avatar_explainer",
  "education",
  "market_update",
  "listing_tour",
  "pre_appointment",
] as const

/** transparency_updates.update_type of the delivered-video portal card. */
export const CLIENT_VIDEO_UPDATE_TYPE = "client_video"

const CLIENT_FACING = new Set<string>(CLIENT_FACING_VIDEO_TYPES)

export interface DeliverableVideoRow {
  video_type?: string | null
  audience_type?: string | null
  contact_id?: string | null
  approval_status?: string | null
  video_url?: string | null
}

/**
 * The delivery RULE, pure. `deliver` only when approved, client-facing, addressed to a contact and
 * rendered; otherwise the reason it stays in the library.
 * File-local: R8 of client-automation-rulings drives it through deliverApprovedClientVideo (reason codes).
 */
function clientVideoDeliveryVerdict(v: DeliverableVideoRow):
  | { deliver: true }
  | { deliver: false; reason: "not_approved" | "not_client_facing" | "no_contact" | "not_rendered" } {
  if (v.approval_status !== "approved") return { deliver: false, reason: "not_approved" }
  if (!CLIENT_FACING.has(String(v.video_type ?? "")) || v.audience_type === "in_house") {
    return { deliver: false, reason: "not_client_facing" }
  }
  if (!v.contact_id) return { deliver: false, reason: "no_contact" }
  if (!v.video_url || !String(v.video_url).trim()) return { deliver: false, reason: "not_rendered" }
  return { deliver: true }
}

export interface ClientVideoDeliveryOutcome {
  delivered: boolean
  reason?: string
  card: "written" | "already" | "skipped" | "failed"
  /** "sent" includes a ledger REPLAY of the same cycle (the earlier send's result, no second send). */
  email: "sent" | "no_email" | "skipped" | "failed"
  detail?: string
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/**
 * Deliver ONE approved client-facing video to its contact: portal card + email. Never throws —
 * the approval / render it rides on stands regardless; every refusal is in the outcome.
 * `svc` is the service client the caller already holds (both callers are server-side, after
 * their own gate); the contact is read IN THE VIDEO'S TENANT, never across.
 */
export async function deliverApprovedClientVideo(
  svc: SupabaseClient,
  videoId: string,
): Promise<ClientVideoDeliveryOutcome> {
  const skip = (reason: string): ClientVideoDeliveryOutcome => ({ delivered: false, reason, card: "skipped", email: "skipped" })
  try {
    const { data: video, error: vErr } = await svc
      .from("ai_video_projects")
      .select("id, brokerage_id, agent_id, contact_id, listing_id, video_type, audience_type, approval_status, video_url, thumbnail_url, title")
      .eq("id", videoId)
      .maybeSingle()
    if (vErr) return { ...skip("video_read_refused"), card: "failed", email: "failed", detail: vErr.message }
    if (!video) return skip("video_not_found")
    const v = video as DeliverableVideoRow & {
      id: string; brokerage_id: string | null; agent_id: string | null; listing_id: string | null
      thumbnail_url: string | null; title: string | null
    }
    const verdict = clientVideoDeliveryVerdict(v)
    if (!verdict.deliver) return skip(verdict.reason)
    if (!v.brokerage_id) return skip("no_tenant")

    const { data: contact, error: cErr } = await svc
      .from("contacts")
      .select("id, brokerage_id, email, first_name")
      .eq("id", v.contact_id as string)
      .eq("brokerage_id", v.brokerage_id)
      .maybeSingle()
    if (cErr) return { ...skip("contact_read_refused"), card: "failed", email: "failed", detail: cErr.message }
    if (!contact) return skip("contact_not_in_tenant")
    const c = contact as { id: string; email: string | null; first_name: string | null }

    // agents.id → users.id (DISJOINT spaces, CLAUDE.md §3) for the signature + the agent's own mailbox.
    let agentUserId: string | null = null
    let agentFirstName: string | null = null
    if (v.agent_id) {
      const { data: agent, error: aErr } = await svc
        .from("agents").select("user_id").eq("id", v.agent_id).eq("brokerage_id", v.brokerage_id).maybeSingle()
      if (aErr) console.error(`[client-video-delivery] agent read refused for video ${v.id}: ${aErr.message}`)
      agentUserId = (agent as { user_id?: string | null } | null)?.user_id ?? null
      if (agentUserId) {
        const { data: u } = await svc.from("users").select("first_name").eq("id", agentUserId).maybeSingle()
        agentFirstName = (u as { first_name?: string | null } | null)?.first_name ?? null
      }
    }

    const displayTitle = String(v.title ?? "A video for you").replace(/^Teammate explainer\s*[—-]\s*/i, "").trim() || "A video for you"
    const fromWho = agentFirstName ? `${agentFirstName} recorded` : "Your agent recorded"

    // ── 1. PORTAL CARD — once per video (checked by id; re-approval writes nothing) ──
    let card: ClientVideoDeliveryOutcome["card"] = "skipped"
    const { data: cards, error: cardReadErr } = await svc
      .from("transparency_updates")
      .select("id, metadata")
      .eq("contact_id", c.id)
      .eq("update_type", CLIENT_VIDEO_UPDATE_TYPE)
    if (cardReadErr) {
      card = "failed"
      console.error(`[client-video-delivery] card read refused for video ${v.id}: ${cardReadErr.message}`)
    } else if (((cards ?? []) as Array<{ metadata?: Record<string, unknown> | null }>)
      .some((r) => r.metadata?.video_project_id === v.id)) {
      card = "already"
    } else {
      const { pushPortalValueCard } = await import("@/lib/kernel/portal-value")
      const pushed = await pushPortalValueCard({
        brokerageId: v.brokerage_id,
        contactId: c.id,
        listingId: v.listing_id ?? null,
        title: displayTitle.slice(0, 200),
        summary: `${fromWho} this video for you. Press play when you have a minute.`,
        updateType: CLIENT_VIDEO_UPDATE_TYPE,
        // Per-video dedupe is the check above; the per-day window would drop a SECOND video the
        // same day, so it is collapsed to "now".
        dedupeWindowMs: 0,
        metadata: { video_url: v.video_url, video_thumbnail_url: v.thumbnail_url ?? null, video_project_id: v.id, video_type: v.video_type },
      }, svc as any)
      card = pushed.pushed ? "written" : "failed"
      if (!pushed.pushed) console.error(`[client-video-delivery] portal card NOT written for video ${v.id}: ${pushed.reason}`)
    }

    // ── 2. EMAIL — the governed chokepoint, at most once per video (ledger cycle) ──
    let email: ClientVideoDeliveryOutcome["email"] = "no_email"
    let detail: string | undefined
    if (c.email) {
      const { embedVideoInEmail } = await import("@/lib/ai-isa/video-generator")
      const greeting = c.first_name ? `Hi ${escapeHtml(c.first_name)},` : "Hi,"
      const html = await embedVideoInEmail(
        `<p>${greeting}</p><p>${escapeHtml(fromWho)} a short video for you: <strong>${escapeHtml(displayTitle)}</strong>.</p>[Video will be embedded here]<p>It is also waiting in your client portal.</p>`,
        v.video_url as string,
        v.thumbnail_url,
      )
      const { dispatchEmail } = await import("@/lib/providers/dispatch")
      const sent = await dispatchEmail({
        brokerageId: v.brokerage_id,
        contactId: c.id,
        userId: agentUserId ?? undefined,
        agentId: v.agent_id ?? undefined,
        sendAsAgentUserId: agentUserId ?? undefined,
        to: c.email,
        subject: `A video for you: ${displayTitle}`.slice(0, 150),
        html,
        text: `${fromWho} a short video for you: ${displayTitle}. Watch: ${v.video_url}`,
        channelPurpose: "conversation",
        systemSource: "client_video_delivery",
        humanApproved: true,
        ledger: { reasonCode: "HUMAN_REQUESTED", cycle: `video:${v.id}` },
        metadata: { video_project_id: v.id, video_type: v.video_type },
      })
      email = sent.success ? "sent" : "failed"
      if (!sent.success) {
        detail = sent.error
        console.error(`[client-video-delivery] email NOT sent for video ${v.id}: ${sent.error}`)
      }
    }
    return { delivered: card === "written" || email === "sent", card, email, detail }
  } catch (err) {
    return { delivered: false, reason: "threw", card: "failed", email: "failed", detail: err instanceof Error ? err.message : String(err) }
  }
}
