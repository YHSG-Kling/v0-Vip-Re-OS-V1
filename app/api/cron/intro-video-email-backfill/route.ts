/**
 * app/api/cron/intro-video-email-backfill/route.ts
 *
 * THE WELCOME SWEEPER. It releases the ONE welcome email once the personal video
 * has landed — or once the wait rule says it never will.
 *
 * ── WHAT THIS ROUTE USED TO BE, AND WHY IT IS NOT THAT ANY MORE ─────────────
 *
 * It used to AUTHOR AND SEND ITS OWN EMAIL — "a quick intro from your agent",
 * with its own hardcoded body — which made it the SECOND, LATER mail a converted
 * contact received, after the invite core's generic magic-link one. The owner's
 * ruling collapses those into one:
 *
 *   "the welcome email is the first on conversion that has the welcome with
 *    portal info to also inclue the embedded personal video."
 *
 * So this route no longer writes a single word of client-facing copy. It decides
 * WHEN, and lib/kernel/client-welcome.ts::ensureClientWelcome — the survivor,
 * chosen because it alone carried portal info, the agent signature, the video
 * block and the compliance gating — decides WHAT. One composer, one send, one
 * compliance rail, one idempotency tag.
 *
 * ── THE WAIT RULE LIVES IN ONE PURE FUNCTION, NOT IN THIS LOOP ──────────────
 *
 * `classifyPendingWelcome` (lib/contact-promotion/conversion-welcome.ts) is the
 * whole decision with no I/O, so every arm — including the ones a live database
 * would almost never produce — is provable without a network. This loop only
 * gathers its inputs and carries out its verdict.
 *
 * ── NOTHING WAITS FOREVER ──────────────────────────────────────────────────
 *
 * Two changes make that true, and both were failures of the old sweep:
 *   · the SET is widened from status='rendering' to every NON-TERMINAL status
 *     (PENDING_WELCOME_STATUSES). A row left at 'queued' by a crashed process was
 *     previously invisible to this cron forever, and with the welcome email now
 *     waiting on it that would mean a contact who is never welcomed at all.
 *   · the DEADLINE (WELCOME_VIDEO_WAIT_MS, measured from the ledger row's own
 *     created_at, i.e. from conversion) is checked BEFORE the assembly gate, so a
 *     stuck Remotion render cannot hold the welcome past it.
 *
 * ── STILL TRUE, AND STILL LOAD-BEARING ─────────────────────────────────────
 *
 * The deliverable is the ASSEMBLED cut, not the raw D-ID talking head. Both land
 * on `ai_video_projects.video_url` — poll-did-videos writes the avatar track and
 * render-composition overwrites it with the branded composite minutes later — so
 * "video_url is populated" alone mails the un-assembled track. The composite gate
 * (lib/video/avatar-render-orchestrator::resolveAvatarCompositeState) is what
 * distinguishes them, and when it has landed we hand its own output URL to the
 * welcome as `videoOverride` rather than waiting another tick for the stamp.
 *
 * ── THE SECOND SWEEP: THE ANNIVERSARY, WHICH IS PORTAL-ONLY ────────────────
 *
 * `agent_intro_videos` carries BOTH triggers and this cron is the only consumer
 * of its `delivery_channel`. The welcome sweep above takes
 * trigger='contact_agent_assigned'; `deliverAnniversaryPortalCards` at the
 * bottom of this file takes trigger='home_anniversary' and stamps the finished
 * clip onto the contact's existing equity_report portal card. Before it, the
 * anniversary rows this cron filtered out sat at 'rendering' forever and their
 * paid D-ID render reached no client surface at all — see that function's own
 * header for the measurement.
 *
 * Auth: CRON_SECRET — same pattern as the rest of the cron fleet.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ensureClientWelcome } from "@/lib/kernel/client-welcome"
import {
  classifyPendingWelcome,
  PENDING_WELCOME_STATUSES,
  WELCOME_VIDEO_WAIT_MS,
} from "@/lib/contact-promotion/conversion-welcome"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

interface BackfillRow {
  id:                  string
  brokerage_id:        string
  contact_id:          string
  agent_id:            string
  video_project_id:    string | null
  delivery_channel:    string
  status:              string | null
  created_at:          string | null
  contact: {
    first_name:    string | null
    last_name:     string | null
    contact_type:  string | null
    email:         string | null
    video_opt_out: boolean | null
  } | null
  project: {
    video_url:         string | null
    status:            string | null
    title:             string | null
    provider_metadata: Record<string, unknown> | null
    completed_at:      string | null
  } | null
}

export async function GET(req: NextRequest) {
  const headerSecret = req.headers.get("authorization")?.replace("Bearer ", "")
  const querySecret  = new URL(req.url).searchParams.get("secret")
  const expected     = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (headerSecret !== expected && querySecret !== expected) return unauthorized()

  const svc = createServiceClient()

  // Up to 50 pending welcomes per tick — drains backlog across runs.
  //
  // `.in("status", PENDING_WELCOME_STATUSES)` — NOT `.eq("status","rendering")`.
  // A ledger row that never left 'queued' still owes somebody a welcome, and the
  // deadline below is what eventually releases it.
  const { data: rows, error } = await svc
    .from("agent_intro_videos")
    .select(`
      id, brokerage_id, contact_id, agent_id, video_project_id, delivery_channel, status, created_at,
      contact:contacts(first_name, last_name, contact_type, email, video_opt_out),
      project:ai_video_projects!agent_intro_videos_video_project_id_fkey(video_url, status, title, provider_metadata, completed_at)
    `)
    .in("status", PENDING_WELCOME_STATUSES as string[])
    .eq("trigger", "contact_agent_assigned")
    .in("delivery_channel", ["email", "both"])
    .order("created_at", { ascending: true })
    .limit(50)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ id: string; outcome: string; reason?: string }> = []
  const now = Date.now()

  for (const r of (rows ?? []) as unknown as BackfillRow[]) {
    // ── THE ASSEMBLY GATE ────────────────────────────────────────────────────
    // Only asked once a project exists AND its avatar track has landed; without a
    // project there is nothing to classify and the row is simply still in flight.
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

    const verdict = classifyPendingWelcome({
      status:         r.status,
      ageMs,
      composite,
      hasRenderedUrl: !!r.project?.video_url,
      videoOptOut:    r.contact?.video_opt_out === true,
      hasEmail:       !!r.contact?.email,
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

    // ── RELEASE THE ONE WELCOME ──────────────────────────────────────────────
    // The survivor owns the copy, the portal block, the agent signature, the
    // compliance gating and the per-contact idempotency tag. It is safe to call
    // twice: a contact who already has a welcome ledger row gets 'skipped', and
    // an UNREADABLE ledger fails closed rather than risking a duplicate.
    //
    // When the assembly landed we hand it the composite's own output URL — the
    // stamp onto ai_video_projects.video_url may be a moment behind, and waiting
    // another tick for a URL we can already see is a delay with no reader.
    const videoOverride =
      verdict.action === "send_with_video"
        ? {
            videoUrl:       compositeUrl ?? (r.project?.video_url as string),
            thumbnailUrl:   null,
            scope:          "contact_personal",
            videoProjectId: r.video_project_id ?? "",
          }
        : null

    const welcome = await ensureClientWelcome(
      svc as any,
      {
        id:          r.contact_id,
        brokerageId: r.brokerage_id,
        contactType: r.contact?.contact_type ?? null,
        firstName:   r.contact?.first_name ?? null,
        lastName:    r.contact?.last_name ?? null,
      },
      { videoOverride },
    )

    // THE LEDGER RECORDS WHAT HAPPENED TO THE VIDEO, NOT WHAT WE HOPED.
    // A send the provider refused must not leave the row reading 'delivered' —
    // that is the "sent" claim backed by nothing the survivor's own contract
    // refuses to make.
    const wentOut = welcome.state === "sent"
    const ledgerStatus = wentOut
      ? verdict.ledgerStatus
      : welcome.state === "skipped"
        ? // Already welcomed (or not a welcome-bearing contact type). The video's
          // job here is done either way; recording 'failed' would file an incident
          // for a correctly-deduped welcome.
          verdict.ledgerStatus
        : "failed"
    const errorMessage = wentOut
      ? verdict.action === "send_with_video"
        ? null
        : verdict.reason
      : `welcome not sent (${welcome.state}): ${welcome.reason ?? verdict.reason}`

    // `status` is NOT NULL and CHECK-constrained. A null here would be refused
    // ENTIRELY (23514/23502) and the row would silently stay pending forever, so
    // the release branches are the only ones that stamp — never a bare `null`.
    if (ledgerStatus) {
      const { error: stampError } = await svc
        .from("agent_intro_videos")
        .update({
          status:        ledgerStatus,
          error_message: errorMessage,
          ...(ledgerStatus === "delivered" ? { delivered_at: new Date().toISOString() } : {}),
        })
        .eq("id", r.id)
      if (stampError) {
        console.error(`[intro-video-email-backfill] ledger stamp refused for ${r.id}: ${stampError.message}`)
      }
    } else {
      console.error(
        `[intro-video-email-backfill] no ledger status resolved for ${r.id} — row left pending rather than ` +
          `stamped with a value the CHECK would refuse`,
      )
    }

    results.push({
      id:      r.id,
      outcome: wentOut
        ? verdict.action === "send_with_video" ? "delivered" : "delivered_without_video"
        : welcome.state,
      reason:  wentOut ? verdict.reason : (welcome.reason ?? verdict.reason),
    })
  }

  const anniversary = await deliverAnniversaryPortalCards(svc)

  return NextResponse.json({
    ran_at:    new Date().toISOString(),
    processed: results.length + anniversary.length,
    results,
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
      await svc.from("agent_intro_videos")
        .update({ status: verdict.ledgerStatus, error_message: verdict.reason })
        .eq("id", raw.id)
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

    await svc.from("agent_intro_videos")
      .update({ status: "delivered", delivered_at: new Date().toISOString(), error_message: null })
      .eq("id", raw.id)
    out.push({ id: raw.id, outcome: "delivered", reason: verdict.reason })
  }

  return out
}
