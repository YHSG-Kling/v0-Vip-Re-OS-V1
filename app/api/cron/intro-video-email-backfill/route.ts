/**
 * app/api/cron/intro-video-email-backfill/route.ts
 *
 * THE WELCOME VIDEO SWEEPER. It puts the agent's personal welcome video into the contact's PORTAL once it is validated, and
 * hands a render that will not land to the manager's recovery. (The path keeps its historical name: lib/kernel/cron-dispatch.ts
 * schedules it and renaming a cron route is a deploy change, not a code change.)
 *
 * ── WAVE 146 (lane 146C) — OWNER RULING 6: THE WELCOME IS IMMEDIATE; THE VIDEO LIVES IN THE PORTAL ──
 *
 * "Welcome email shouldn't wait for a video so send welcome email out right away and put the welcome personal video in-app
 * contact portal so the contact sees it right away." The ONE welcome email now goes at CONVERSION
 * (lib/contact-promotion/conversion-welcome.ts deliverConversionWelcome → lib/kernel/client-welcome.ts ensureClientWelcome). So
 * this route sends NO email at all any more and writes no client-facing copy. For each pending welcome render it:
 *   · asks the assembly gate (resolveAvatarCompositeState) and the PURE decision (lib/portal/welcome-video.ts
 *     classifyPortalWelcomeVideo — the deadline checked BEFORE the assembly gate, so nothing waits forever);
 *   · on `place`, reads the video BACK through the portal's own reader (portalWelcomeVideoFor — what the portal renders from)
 *     and only then records it delivered, with evidence (placePortalWelcomeVideo — never a false video-complete state);
 *   · on `fail` (past the deadline), records 'failed' (counted) and runs the manager's recovery (recoverPortalWelcomeVideo: the
 *     agent's standing video stands in, one bounded re-render through the spine's retry door, or a person is told once);
 * and then recovers the renders the SPINE itself recorded failed / suppressed (recoverFailedPortalWelcomeVideos).
 *
 * TOMBSTONES (wave 146 — §1.3, the functionality moved / was overruled), each measured live before retiring
 * (hrvaqgvukzxfskkcrwbt, 2026-10-29: agent_intro_videos 0, welcome_without_video items 0, client_welcome_v1 messages 0):
 *   · the welcome RELEASE (`ensureClientWelcome` with a `videoOverride`, wave 145 ruling 17 — the welcome waited for the video):
 *     the welcome goes at conversion now; survivor lib/contact-promotion/conversion-welcome.ts deliverConversionWelcome;
 *   · the wave-144 video FOLLOW-UP mail (`deliverWelcomeVideoFollowUp`, `readWelcomeState`): the video never travels by mail now;
 *     survivor lib/portal/welcome-video.ts (the portal is the delivery);
 *   · the `hold_for_exception` filing and `releaseApprovedWelcomeExceptions` (ruling 17's `welcome_without_video` approval item):
 *     nothing is held any more; a failed video is recovered / told to a person by lib/portal/welcome-video.ts
 *     recoverPortalWelcomeVideo / escalatePortalWelcomeVideo.
 *
 * ── STILL TRUE, AND STILL LOAD-BEARING ─────────────────────────────────────
 *
 * The deliverable is the ASSEMBLED cut, not the raw D-ID talking head. Both land on `ai_video_projects.video_url` —
 * poll-did-videos writes the avatar track and render-composition overwrites it with the branded composite minutes later — so
 * "video_url is populated" alone would surface the un-assembled track. The composite gate is what distinguishes them; when it
 * has landed its own output URL is the deliverable the placement expects the portal to read back.
 *
 * ── THE SECOND SWEEP: THE ANNIVERSARY, WHICH IS PORTAL-ONLY ────────────────
 *
 * `agent_intro_videos` carries BOTH triggers and this cron is the only consumer of its delivery. The welcome sweep above takes
 * trigger='contact_agent_assigned'; `deliverAnniversaryPortalCards` at the bottom of this file takes
 * trigger='home_anniversary' and stamps the finished clip onto the contact's existing equity_report portal card. Before it, the
 * anniversary rows this cron filtered out sat at 'rendering' forever and their paid D-ID render reached no client surface at
 * all — see that function's own header for the measurement.
 *
 * Auth: CRON_SECRET — same pattern as the rest of the cron fleet.
 */
import { NextResponse, type NextRequest } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"
import { PENDING_WELCOME_STATUSES, WELCOME_VIDEO_WAIT_MS } from "@/lib/contact-promotion/conversion-welcome"
import {
  classifyPortalWelcomeVideo,
  placePortalWelcomeVideo,
  recoverPortalWelcomeVideo,
  recoverFailedPortalWelcomeVideos,
  PORTAL_WELCOME_VIDEO_TRIGGER,
} from "@/lib/portal/welcome-video"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"

export const dynamic = "force-dynamic"
export const maxDuration = 300


interface PendingWelcomeRow {
  id:                  string
  brokerage_id:        string
  contact_id:          string
  agent_id:            string
  video_project_id:    string | null
  status:              string | null
  created_at:          string | null
  project: {
    video_url:         string | null
    status:            string | null
    provider_metadata: Record<string, unknown> | null
    completed_at:      string | null
  } | null
}

export async function GET(req: NextRequest) {
  const denied = verifyCronAuth(req)
  if (denied) return denied

  const svc = createServiceClient()

  // Up to 50 pending welcome renders per tick — drains backlog across runs. Every NON-TERMINAL status (a row left at 'queued'
  // by a crashed process still owes the contact a portal video, and the deadline below is what eventually hands it on). Any
  // delivery_channel: every welcome render lives in the portal now (owner ruling 6), whatever it was commissioned under.
  const { data: rows, error } = await svc
    .from("agent_intro_videos")
    .select(`
      id, brokerage_id, contact_id, agent_id, video_project_id, status, created_at,
      project:ai_video_projects!agent_intro_videos_video_project_id_fkey(video_url, status, provider_metadata, completed_at)
    `)
    .in("status", PENDING_WELCOME_STATUSES as string[])
    .eq("trigger", "contact_agent_assigned")
    .order("created_at", { ascending: true })
    .limit(50)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ id: string; outcome: string; reason?: string }> = []
  const now = Date.now()

  for (const r of (rows ?? []) as unknown as PendingWelcomeRow[]) {
    // ── THE ASSEMBLY GATE ────────────────────────────────────────────────────
    // Only asked once a project exists AND its avatar track has landed; without a project there is nothing to classify and the
    // row is simply still in flight.
    let composite: "not_requested" | "pending" | "landed" | "abandoned" | null = null
    let compositeUrl: string | null = null
    let compositeReason: string | undefined
    if (r.video_project_id && r.project?.video_url) {
      const { resolveAvatarCompositeState } = await import("@/lib/video/avatar-render-orchestrator")
      const state = await resolveAvatarCompositeState(
        {
          id:                r.video_project_id,
          provider_metadata: r.project.provider_metadata,
          completed_at:      r.project.completed_at,
        },
        svc,
      )
      composite = state.state
      if (state.state === "landed") compositeUrl = state.outputUrl
      if (state.state === "pending" || state.state === "abandoned") compositeReason = state.reason
    }

    const ageMs = r.created_at ? now - new Date(r.created_at).getTime() : null

    const verdict = classifyPortalWelcomeVideo({
      status:         r.status,
      ageMs,
      composite,
      hasRenderedUrl: !!r.project?.video_url,
      waitMs:         WELCOME_VIDEO_WAIT_MS,
    })

    if (verdict.action === "wait") {
      results.push({ id: r.id, outcome: "waiting", reason: compositeReason ?? verdict.reason })
      continue
    }
    if (verdict.action === "skip") {
      results.push({ id: r.id, outcome: "skipped", reason: verdict.reason })
      continue
    }

    // ── PAST THE DEADLINE: RECORDED, THEN THE MANAGER'S RECOVERY ─────────────
    // The stamp is guarded on the pending status it was read in and COUNTED (an UPDATE that matches nothing resolves like one
    // that worked). The portal never showed a false video; recovery decides stand-in / one re-render / a person.
    if (verdict.action === "fail") {
      const { data: stamped, error: stampError } = await svc
        .from("agent_intro_videos")
        .update({ status: "failed", error_message: verdict.reason })
        .eq("id", r.id)
        .eq("brokerage_id", r.brokerage_id)
        .in("status", PENDING_WELCOME_STATUSES as string[])
        .select("id")
      if (stampError || (stamped ?? []).length === 0) {
        console.error(`[intro-video-email-backfill] failure stamp did not land for ${r.id}: ${stampError?.message ?? "0 rows matched"}`)
        results.push({ id: r.id, outcome: "failure_not_stamped", reason: stampError?.message ?? "0 rows matched — re-read next tick" })
        continue
      }
      const recovery = await recoverPortalWelcomeVideo(svc, {
        brokerageId: r.brokerage_id, contactId: r.contact_id, agentId: r.agent_id, introVideoId: r.id,
        failureKind: "timeout", reason: verdict.reason,
      })
      results.push({ id: r.id, outcome: `failed:${recovery.action}:${recovery.outcome}`, reason: recovery.reason })
      continue
    }

    // ── PLACE IT: READ BACK THROUGH THE PORTAL'S OWN READER, THEN RECORD IT DELIVERED ──
    // The composite's own output URL is the deliverable when the assembly landed (the stamp onto ai_video_projects.video_url
    // may be a moment behind); it rides the evidence as what the portal is expected to show.
    const placed = await placePortalWelcomeVideo(svc, {
      introVideoId:   r.id,
      brokerageId:    r.brokerage_id,
      contactId:      r.contact_id,
      videoProjectId: r.video_project_id,
      expectedUrl:    compositeUrl ?? r.project?.video_url ?? null,
    })
    results.push({ id: r.id, outcome: placed.placed ? "in_portal" : `not_placed:${placed.readback}`, reason: placed.reason })
  }

  // ── THE RENDERS THE SPINE ITSELF RECORDED FAILED / SUPPRESSED (never pending, so never in the set above) ──
  const recovered = await recoverFailedPortalWelcomeVideos(svc, {})
  if (recovered.error) console.error(`[intro-video-email-backfill] failed portal welcome videos not recovered: ${recovered.error}`)

  const anniversary = await deliverAnniversaryPortalCards(svc)

  return NextResponse.json({
    ran_at:    new Date().toISOString(),
    processed: results.length + recovered.examined + anniversary.length,
    trigger:   PORTAL_WELCOME_VIDEO_TRIGGER,
    results,
    recovered,
    anniversary,
  })
}

// ─── THE ANNIVERSARY HALF ─────────────────────────────────────────────────────
/**
 * THE ANNIVERSARY AVATAR VIDEO REACHES THE PORTAL, OR IT REACHES NOBODY.
 *
 * WHAT WAS MEASURED. `dispatchAnniversaryVideo` renders a real D-ID talking head
 * from the agent's stored avatar + cloned voice and files an `agent_intro_videos`
 * row at status='rendering'. Nothing ever moved that row off 'rendering', and
 * nothing ever showed the clip to the client:
 *   · the email sweep above filters `trigger='contact_agent_assigned'`;
 *   · handleVideoGenerated's per-contact drafts fire only for video_type in
 *     (thank_you, personal, buyer_guide, memory_video) and the anniversary row is
 *     stamped 'just_sold', and its listing branches need a listing_id it has not
 *     got;
 *   · lib/kernel/anniversary-equity.ts pushes its portal value card BEFORE
 *     commissioning the video and never returns to it;
 *   · lib/kernel/welcome-personal-video.ts reads the ledger at CONVERSION, years
 *     before any anniversary.
 * So the only reader was the agent's own "Video Ready" notification. A paid
 * render with no client-facing reader is CLAUDE.md §1's writer-with-no-reader,
 * and it cost D-ID credit every year per past client.
 *
 * THE MISSING HALF, BUILT ON THE EXISTING RAILS. The anniversary already owns a
 * portal card (`transparency_updates`, update_type 'equity_report', pushed
 * through the ONE primitive lib/kernel/portal-value.ts) and the portal feed
 * already knows how to play a clip off a card's metadata
 * (app/portal/[contactId]/components/RecentUpdatesFeed.tsx). This stamps the
 * finished clip onto that card. No second card, no second rail.
 *
 * IT WAITS FOR THE ASSEMBLY, exactly as the email half does — same shared
 * predicate, same 2h bound, so a cancelled or never-enqueued composite ships the
 * D-ID cut instead of stalling forever.
 *
 * NO CARD, NO STAMP. The card is written before the video is commissioned, so
 * its absence means something upstream failed; inventing an anniversary card
 * here would be a portal surface with no computed value behind it, which is what
 * lib/kernel/portal-value.ts exists to prevent.
 */
async function deliverAnniversaryPortalCards(
  svc: ReturnType<typeof createServiceClient>,
): Promise<Array<{ id: string; outcome: string; reason?: string }>> {
  const out: Array<{ id: string; outcome: string; reason?: string }> = []

  const { data: rows, error } = await svc
    .from("agent_intro_videos")
    .select(`
      id, brokerage_id, contact_id, agent_id, video_project_id, delivery_channel,
      contact:contacts(first_name, video_opt_out),
      project:ai_video_projects!agent_intro_videos_video_project_id_fkey(video_url, thumbnail_url, status, provider_metadata, completed_at)
    `)
    .eq("status", "rendering")
    .eq("trigger", "home_anniversary")
    .in("delivery_channel", ["portal", "both"])
    .not("video_project_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(50)
  // supabase-js RESOLVES a refusal — read the error rather than treating an
  // empty list as "nothing to deliver".
  if (error) {
    out.push({ id: "-", outcome: "failed", reason: `anniversary sweep unreadable: ${error.message}` })
    return out
  }

  const { resolveAvatarCompositeState, classifyAnniversaryPortalDelivery } =
    await import("@/lib/video/avatar-render-orchestrator")

  for (const raw of (rows ?? []) as unknown as Array<{
    id: string
    contact_id: string
    video_project_id: string | null
    contact: { first_name: string | null; video_opt_out: boolean | null } | null
    project: {
      video_url: string | null
      thumbnail_url: string | null
      provider_metadata: Record<string, unknown> | null
      completed_at: string | null
    } | null
  }>) {
    // The composite is only asked about once the avatar track exists; without it
    // there is nothing to classify and the row is simply still in flight.
    let composite: import("@/lib/video/avatar-render-orchestrator").AvatarCompositeState | null = null
    if (raw.project?.video_url) {
      composite = await resolveAvatarCompositeState(
        {
          id:                raw.video_project_id!,
          provider_metadata: raw.project.provider_metadata,
          completed_at:      raw.project.completed_at,
        },
        svc,
      )
    }

    // The portal card read has to happen before the verdict, because "is there a
    // card?" is one of its inputs. A REFUSED read is not the same as "no card" —
    // one is retried next tick, the other closes the row — so the refusal is
    // carried out separately rather than collapsing into `hasPortalCard: false`.
    const { data: cards, error: cardError } = await svc
      .from("transparency_updates")
      .select("id, metadata")
      .eq("contact_id", raw.contact_id)
      .eq("update_type", "equity_report")
      .eq("is_visible_to_client", true)
      .order("created_at", { ascending: false })
      .limit(1)
    if (cardError) {
      out.push({ id: raw.id, outcome: "deferred", reason: `portal card unreadable: ${cardError.message}` })
      continue
    }
    const card = (cards ?? [])[0] as { id: string; metadata: Record<string, unknown> | null } | undefined

    const verdict = classifyAnniversaryPortalDelivery({
      hasRenderedUrl: !!raw.project?.video_url,
      composite:      composite?.state ?? null,
      videoOptOut:    raw.contact?.video_opt_out === true,
      hasPortalCard:  !!card,
    })

    if (verdict.action === "wait") {
      out.push({ id: raw.id, outcome: "waiting", reason: verdict.reason })
      continue
    }
    if (verdict.action === "close") {
      await sentinelWrite(svc, svc.from("agent_intro_videos")
        .update({ status: verdict.ledgerStatus, error_message: verdict.reason })
        .eq("id", raw.id), { table: "agent_intro_videos", flow: "intro_video_backfill_close", reason: "ledger close on a row the backfill decided to stop; the next run re-decides" })
      out.push({ id: raw.id, outcome: verdict.ledgerStatus, reason: verdict.reason })
      continue
    }

    // Prefer the composite's own output URL over the row snapshot this tick
    // read — the stamp onto ai_video_projects.video_url may be a moment behind.
    const deliverableUrl =
      composite?.state === "landed" && composite.outputUrl
        ? composite.outputUrl
        : (raw.project?.video_url as string)

    // A DELETE-SHAPED TRAP IN UPDATE CLOTHING: an UPDATE that matches nothing
    // also resolves with error=null. `.select()` it and COUNT what came back,
    // so a card that vanished between the read and the write is not recorded as
    // a delivery that happened.
    const { data: stamped, error: stampError } = await svc
      .from("transparency_updates")
      .update({
        metadata: {
          ...(card!.metadata ?? {}),
          anniversary_video_url:           deliverableUrl,
          anniversary_video_thumbnail_url: raw.project?.thumbnail_url ?? null,
          anniversary_video_project_id:    raw.video_project_id,
          anniversary_video_assembled:     verdict.assembled,
        },
      })
      .eq("id", card!.id)
      .select("id")
    if (stampError || !stamped || stamped.length === 0) {
      out.push({
        id: raw.id,
        outcome: "deferred",
        reason: stampError?.message ?? "portal card matched no row at write time",
      })
      continue
    }

    await sentinelWrite(svc, svc.from("agent_intro_videos")
      .update({ status: "delivered", delivered_at: new Date().toISOString(), error_message: null })
      .eq("id", raw.id), { table: "agent_intro_videos", flow: "intro_video_backfill_delivered", reason: "delivery stamp AFTER the send; a lost stamp is ledgered so the repair digest shows a possible re-send" })
    out.push({ id: raw.id, outcome: "delivered", reason: verdict.reason })
  }

  return out
}
