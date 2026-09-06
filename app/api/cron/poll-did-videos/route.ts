/**
 * Cron: poll-did-videos
 * Runs every 2 minutes (configure in vercel.json) to check D-ID render status
 * for all ai_video_projects in 'generating' state with provider_metadata.provider='did'.
 *
 * D-ID flow:
 *   1. /api/did/generate-video submits a job → stores provider_job_id + status='generating'
 *   2. This cron polls GET /talks/{id} (or /clips/{id}) until status='done' or 'error'
 *   3. On done: stores video_url, thumbnail_url, marks status='completed', notifies agent
 *   4. On error: marks status='failed' with the D-ID error message
 *
 * D-ID GET /talks/{id} response shape:
 *   { id, status: "created"|"started"|"done"|"error"|"rejected", result_url, audio_url, error?, ... }
 */

import { type NextRequest, NextResponse } from "next/server"
import { classifyDidError } from "@/lib/did/contract"
import { didRequest } from "@/lib/did/gateway"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import { emitEventFromCron } from "@/lib/orchestrator/internal"
import { verifyCronAuth } from "@/lib/cron-auth"

const DID_API_BASE = "https://api.d-id.com"

/**
 * CLOSE OUT the render ledger row for one D-ID job.
 *
 * `video_render_log` is the per-attempt cost/SLA/debug ledger
 * (scripts/992-create-video-render-log.sql). Its `status` carries DEFAULT
 * 'submitted' and its `error_message` had no writer at all, so the render-attempt
 * list an agent sees (app/components/content-studio/LinkToVideoGenerator.tsx:614,
 * fed by app/actions/link-to-video.ts:586) showed every attempt — successes and
 * hard failures alike — as a permanent "submitted" with no reason attached. The
 * project row already learned the outcome at each of the four terminal points
 * below; the ledger never did.
 *
 * Keyed on project_id AND provider_job_id so a re-render's ledger line is not
 * overwritten by the outcome of the previous attempt: the submit route
 * (app/api/did/generate-video/route.ts) now stamps the talk id on the row it
 * inserts. Rows written before that stamp existed carry a NULL job id and are
 * left alone rather than being back-filled with a guess.
 *
 * Best-effort: the project's own status is the source of truth for the agent, and
 * a refused audit write must never turn a delivered video into a failure. But the
 * refusal IS read and logged (CLAUDE.md §3) — a silently swallowed one is how
 * this ledger came to look empty.
 */
async function recordRenderOutcome(
  supabase: ReturnType<typeof createServiceClient>,
  projectId: string,
  providerJobId: string | null | undefined,
  outcome: { status: string; errorMessage?: string | null; renderDurationSeconds?: number | null },
): Promise<void> {
  if (!providerJobId) return
  // Every column NAMED, no spread. A `{ ...patch }` update object is opaque to
  // every static scanner in this repo, and an opaque write does not merely hide
  // these three columns — it suppresses the honest finding still outstanding on
  // this table (`cost_usd`, which has no provider price source and therefore
  // still has no writer). Hiding a real gap is worse than leaving it visible.
  const { error } = await supabase
    .from("video_render_log")
    .update({
      status: outcome.status,
      error_message: outcome.errorMessage ?? null,
      render_duration_seconds: outcome.renderDurationSeconds ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("project_id", projectId)
    .eq("provider_job_id", providerJobId)
  if (error) {
    console.error(`[poll-did-videos] render log outcome not recorded for ${projectId}: ${error.message}`)
  }
}


export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "poll-did-videos",
    cron_path: "/app/api/cron/poll-did-videos/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const supabase = createServiceClient()
    const didApiKey = process.env.DID_API_KEY

    if (!didApiKey) {
      await recordCronSuccessAction({
        context_id: contextId,
        records_processed: 0,
        output_count: 0,
        metadata: { skipped: "DID_API_KEY not configured" },
      })
      return NextResponse.json({ success: false, message: "DID_API_KEY not configured", processed: 0 })
    }

    // Fetch all D-ID jobs that are still generating
    const { data: pending, error: fetchError } = await supabase
      .from("ai_video_projects")
      .select("id, agent_id, brokerage_id, listing_id, contact_id, marketing_campaign_id, provider_job_id, provider_metadata, status, retry_count, video_type, usage_intent, background_type, background_url, intro_video_url, outro_video_url, b_roll_urls")
      .eq("status", "generating")
      .not("provider_job_id", "is", null)
      .filter("provider_metadata->>provider", "eq", "did")
      .limit(20)

    if (fetchError) throw fetchError

    const results = {
      processed: 0,
      completed: 0,
      failed: 0,
      still_processing: 0,
    }

    const auth = `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`

    for (const video of pending ?? []) {
      results.processed++

      try {
        // ai_video_projects.agent_id is agents-class since m366. Every notify /
        // event hand-off below writes a USERS id (notifications.user_id,
        // lifecycle_events.actor_user_id, the payload's agent_user_id), so the
        // owner is resolved once per row. Null = the agents row is gone; those
        // hand-offs are then skipped with a line naming the row, never sent with
        // the agents id standing in for a users id.
        const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
        const agentUserId = video.agent_id ? await resolveAgentRecordToUserId(video.agent_id) : null
        if (video.agent_id && !agentUserId) {
          console.error(`[poll-did-videos] no users row behind agents.id=${video.agent_id} (project ${video.id}) — owner notifications skipped`)
        }

        // Engine by job: clips (V3 Pro), expressives (V4 — owner rule for
        // personalized avatar video), else the classic talks (V2 photo).
        const pmeta = video.provider_metadata as any
        // Engine keyed off the RECORDED provider_metadata.mode (stamped at
        // submit); the id-prefix check survives only for pre-stamp legacy rows.
        const mode = pmeta?.mode === "clip" ? "clips"
          : pmeta?.mode === "expressive" || String(video.provider_job_id ?? "").startsWith("exp") ? "expressives"
          : "talks"
        // Through Connection OS — see lib/did/gateway.ts.
        const statusRes = await didRequest<any>(
          `/${mode}/${video.provider_job_id}`, { withExternalKey: false },
        )

        if (!statusRes.ok) {
          // A 404 is TERMINAL, not transient: D-ID no longer has this job (it
          // expired, or the id was never valid), so no number of ticks will
          // ever resolve it. `continue` on every non-ok status meant such a row
          // sat at 'generating' forever, re-fetched on every tick, invisible to
          // the agent waiting on the video. Same defect the avatar poll cron
          // carried (m316) — fixing one and not its sibling is how a defect
          // class survives being found.
          if (statusRes.status === 404) {
            await supabase
              .from("ai_video_projects")
              .update({
                status: "failed",
                provider_status: "not_found",
                error_message: `D-ID no longer has job ${video.provider_job_id} (404 on /${mode}) — it expired or was never created`,
                retry_count: (video.retry_count ?? 0) + 1,
              })
              .eq("id", video.id)
            if (agentUserId) {
              await supabase.from("notifications").insert({
                user_id: agentUserId,
                brokerage_id: video.brokerage_id,
                type: "video_failed",
                title: "Video Generation Failed",
                body: "Your video could not be retrieved from the provider. Please try generating it again.",
                entity_type: "video_project",
                entity_id: video.id,
                priority: "high",
                is_read: false,
              })
            }
            await recordRenderOutcome(supabase, video.id, video.provider_job_id, {
              status: "failed",
              errorMessage: `D-ID no longer has job ${video.provider_job_id} (404 on /${mode}) — it expired or was never created`,
            })
            results.failed++
            continue
          }
          // Everything else goes through the ONE classifier. A 402 (out of
          // credits) or 451 (moderation) never succeeds on a later tick;
          // retrying them forever hides the answer from the agent waiting.
          const errBody = statusRes.data ?? { description: statusRes.error }
          const failure = classifyDidError(statusRes.status, errBody)
          if (failure.retryable) continue
          await supabase.from("ai_video_projects").update({
            status: "failed",
            provider_status: failure.kind,
            error_message: failure.userMessage,
            retry_count: (video.retry_count ?? 0) + 1,
          }).eq("id", video.id)
          await recordRenderOutcome(supabase, video.id, video.provider_job_id, {
            status: "failed",
            errorMessage: failure.userMessage,
          })
          console.error(`[poll-did-videos] terminal for ${video.id}: ${failure.operatorMessage}`)
          results.failed++
          continue
        }

        const data = statusRes.data ?? {}
        const didStatus: string = data.status

        if (didStatus === "done") {
          const didResultUrl: string | null = data.result_url ?? null
          const didThumbnailUrl: string | null = data.thumbnail_url ?? null
          const duration: number | null =
            typeof data.duration === "number" ? Math.round(data.duration) : null

          // ─── Persist video + thumbnail to OUR bucket, immediately ──────────
          // D-ID result URLs are signed and expire in ~24–48h. Download the bytes
          // the moment the render completes and host them ourselves so an email,
          // newsletter, portal card or listing page embeds a URL that is still
          // alive next month.
          //
          // ONE MEDIA HOST. hostRenderedMedia is the same host every other
          // finished byte rides (render coordinator, render endpoint, stills,
          // thumbnails, voiceovers, the lib/did re-upload).
          //
          // THE COMMENT THAT STOOD HERE WAS FALSE. It said "Supabase storage
          // first, Vercel Blob as the fallback, so a bucket copy exists even
          // when storage is down." @vercel/blob was RETIRED on the owner's
          // ruling that all file storage lives in Supabase buckets
          // (lib/remotion/media-host.ts header, scripts/vercel-blob-retired-guard.ts):
          // there is no second host and hostRenderedMedia THROWS when the bucket
          // refuses. A stale comment at the exact spot a reader checks whether a
          // failure is survivable is worse than none, because it says the
          // failure is already handled.
          //
          // WHAT ACTUALLY HAPPENS WHEN THE RE-HOST FAILS is decided below, at
          // finalVideoUrl — see the block there.
          const { hostRenderedMedia } = await import("@/lib/remotion/media-host")
          let persistedVideoUrl: string | null = null
          let persistedThumbnailUrl: string | null = null
          const agentFolder = video.agent_id ?? "shared"

          if (didResultUrl) {
            try {
              const videoFetch = await fetch(didResultUrl)
              if (videoFetch.ok) {
                const videoBuffer = Buffer.from(await videoFetch.arrayBuffer())
                persistedVideoUrl = await hostRenderedMedia(
                  supabase, `agent-videos/${agentFolder}/${video.id}.mp4`, videoBuffer, "video/mp4",
                )
              } else {
                console.error(`[poll-did-videos] D-ID result download failed: HTTP ${videoFetch.status}`)
              }
            } catch (storageErr: any) {
              // Non-fatal — the D-ID URL is still recorded below, but say so:
              // a delivered link that points at it has a 24–48h life.
              console.error("[poll-did-videos] Video persist failed:", storageErr?.message ?? storageErr)
            }
          }

          if (didThumbnailUrl) {
            try {
              const thumbFetch = await fetch(didThumbnailUrl)
              if (thumbFetch.ok) {
                const thumbBuffer = Buffer.from(await thumbFetch.arrayBuffer())
                persistedThumbnailUrl = await hostRenderedMedia(
                  supabase, `agent-videos/${agentFolder}/${video.id}-thumb.jpg`, thumbBuffer, "image/jpeg",
                )
              }
            } catch (thumbErr: any) {
              console.error("[poll-did-videos] Thumbnail persist failed:", thumbErr?.message ?? thumbErr)
            }
          }

          // ─── Pixel-level visual brand overlay (sprint C — now live) ─────────
          // Public-marketing videos get the brokerage logo + attribution band
          // burned in via ffmpeg. MLS-bound videos pass through untouched
          // because MLS rules forbid agent/brokerage branding.
          const usageIntent: string = (video as any).usage_intent ?? "public_marketing"
          let brandedVideoUrl: string | null = null
          let visualOverlayApplied = false

          if (persistedVideoUrl && usageIntent !== "mls") {
            try {
              const { data: brokerage } = await supabase
                .from("brokerages")
                .select("name, dba, logo_url, license_number, license_state")
                .eq("id", video.brokerage_id ?? "")
                .maybeSingle()

              // Team logo/name via the agent's team_id (FK chain agents.team_id → teams)
              let teamName: string | null = null
              let teamLogoUrl: string | null = null
              if (video.agent_id) {
                const { data: agentRow } = await supabase
                  .from("agents")
                  .select("team_id")
                  .eq("id", video.agent_id)
                  .maybeSingle()
                if (agentRow?.team_id) {
                  const { data: team } = await supabase
                    .from("teams")
                    .select("name, logo_url")
                    .eq("id", agentRow.team_id)
                    .maybeSingle()
                  teamName    = team?.name ?? null
                  teamLogoUrl = team?.logo_url ?? null
                }
              }

              // Explainer mode — when background_type='video' and a background
              // URL is set, the talking head becomes a PIP in the bottom-right
              // over a property walkthrough / drone footage / market-update
              // background. Logo moves to top-left so it doesn't collide with
              // the PIP. Audio is pulled from the talking head.
              //
              // Standard mode — single talking head, logo bottom-right.
              const isExplainer =
                (video as any).background_type === "video" &&
                typeof (video as any).background_url === "string" &&
                (video as any).background_url.length > 0
              const brand = {
                brokerageName:         brokerage?.name ?? null,
                brokerageDba:          brokerage?.dba ?? null,
                brokerageLicense:      brokerage?.license_number ?? null,
                brokerageLicenseState: brokerage?.license_state ?? null,
                teamName,
                logoUrl:               teamLogoUrl ?? brokerage?.logo_url ?? null,
              }

              const { compositeVideoAttribution, compositeExplainerVideo, concatIntroOutro, compositeBrollCutaways } =
                await import("@/lib/video/composite-attribution")

              // B-ROLL CUTAWAYS run FIRST (talking-head mode only — explainer
              // mode already carries a full-frame background): property clips
              // cut away full-frame while the voice-over continues, and the
              // attribution band then lands ON TOP so it stays visible through
              // the whole timeline (compliance). Best-effort like every other
              // compositing step.
              let brolledBuffer: Buffer | null = null
              const brollUrls = ((video as any).b_roll_urls as string[] | null) ?? []
              // OWNER RULE: b-roll must NEVER ride an MLS walkthrough. The
              // usage_intent==='mls' gate above already excludes MLS renders
              // from ALL compositing; this adds the explicit walkthrough guard
              // (defense in depth — a walkthrough IS the property footage, a
              // cutaway would cover the very thing being toured).
              const isWalkthrough = String((video as any).video_type ?? "").includes("walkthrough")
              if (!isExplainer && !isWalkthrough && brollUrls.length > 0) {
                const raw = await fetch(persistedVideoUrl).then(async (r) => (r.ok ? Buffer.from(await r.arrayBuffer()) : null)).catch(() => null)
                if (raw) {
                  const brolled = await compositeBrollCutaways({ mainVideoBuffer: raw, brollUrls })
                  if (brolled.overlayApplied && brolled.outputBuffer.length > 0) brolledBuffer = brolled.outputBuffer
                }
              }

              let result = isExplainer
                ? await compositeExplainerVideo({
                    backgroundVideoUrl:  (video as any).background_url,
                    talkingHeadVideoUrl: persistedVideoUrl,
                    brand,
                  })
                : await compositeVideoAttribution({
                    inputVideoUrl: persistedVideoUrl,
                    inputVideoBuffer: brolledBuffer,
                    brand,
                  })
              // The compliance flag (visualOverlayApplied) must mean the BRAND
              // band landed — b-roll alone doesn't satisfy it. But a b-rolled
              // video is still a changed video worth uploading when the band
              // was skipped (e.g. mls_clean), so track the two separately.
              const brandOverlayApplied = result.overlayApplied
              if (!isExplainer && brolledBuffer && !result.overlayApplied && result.outputBuffer.length > 0) {
                result = { outputBuffer: result.outputBuffer, overlayApplied: true }
              }

              // Intro / outro bookends — applied AFTER the brand overlay so the
              // brokerage-curated intro/outro clips don't get another attribution
              // band stacked on top of theirs (they're already brokerage-approved).
              // Best-effort: if the bookend concat fails the agent still gets the
              // branded main video.
              const introUrl = (video as any).intro_video_url as string | null
              const outroUrl = (video as any).outro_video_url as string | null
              if (result.overlayApplied && result.outputBuffer.length > 0 && (introUrl || outroUrl)) {
                const bookended = await concatIntroOutro({
                  mainVideoBuffer: result.outputBuffer,
                  introVideoUrl:   introUrl,
                  outroVideoUrl:   outroUrl,
                })
                if (bookended.overlayApplied && bookended.outputBuffer.length > 0) {
                  // Replace result so the bookended buffer is what gets uploaded
                  result = { outputBuffer: bookended.outputBuffer, overlayApplied: true }
                }
              }

              if (result.overlayApplied && result.outputBuffer.length > 0) {
                // Upload the branded version. Suffix the path so we keep both
                // — the clean D-ID render stays available for MLS export.
                const agentFolder = video.agent_id ?? "shared"
                const brandedPath = `agent-videos/${agentFolder}/${video.id}.branded.mp4`
                // ONE HOST, ONE ISSUER. This was a bare
                // `.storage.from("listing-media").upload(...)` followed by a
                // bare `.getPublicUrl(...)` — the only bucket write in this file
                // that skipped both the size/mime gate and
                // lib/storage/document-buckets.ts#issueBucketObjectUrl, while
                // the two persist calls a hundred lines above ride
                // hostRenderedMedia. `listing-media` is public-media so the URL
                // it minted was class-correct today; the point is that nothing
                // was CHECKING that, and a reclassification of the bucket would
                // have moved every other call site and silently missed this one.
                // The bucket is named explicitly so the destination is exactly
                // what it was before this change.
                try {
                  brandedVideoUrl = await hostRenderedMedia(
                    supabase, brandedPath, result.outputBuffer, "video/mp4", "listing-media",
                  )
                  // Compliance truth: only the BRAND band satisfies the visual
                  // overlay requirement (b-roll-only composites don't).
                  visualOverlayApplied = brandOverlayApplied
                } catch (brandedUploadErr: any) {
                  // hostRenderedMedia THROWS on a storage refusal (the Vercel
                  // Blob fallback that used to swallow it is retired), so this
                  // catch is what keeps the branded overlay best-effort: the
                  // clean re-hosted cut below is still delivered.
                  console.error("[poll-did-videos] Branded upload failed:", brandedUploadErr?.message ?? brandedUploadErr)
                }
              }
            } catch (overlayErr: any) {
              // Overlay is best-effort — fall back to the un-branded persisted
              // video. Compliance gate will flag the missing visual overlay.
              console.error("[poll-did-videos] Visual overlay failed:", overlayErr?.message ?? overlayErr)
            }
          }

          // ─── THE DELIVERY URL IS OURS, OR THERE IS NO DELIVERY YET ────────
          //
          // This used to read:
          //
          //     const finalVideoUrl = brandedVideoUrl ?? persistedVideoUrl ?? didResultUrl
          //     const finalThumbnailUrl = persistedThumbnailUrl ?? didThumbnailUrl
          //
          // …so when the re-host above failed, the row was still marked
          // `completed` with D-ID's own URL in video_url. That is not a
          // degraded copy of the right answer, it is the wrong answer that
          // LOOKS like the right one: D-ID result URLs are signed and expire in
          // ~24-48h (this file says so twenty lines up), and by then the string
          // has been fanned out by the `done` branch below into an agent
          // notification, the video.generated orchestrator event (email drafts,
          // SMS drafts, social drafts, campaign assets), the listing page, the
          // avatar→Remotion handoff and — via lead_capture_forms.landing_content
          // — a PUBLIC lead-magnet landing page. Every one of those keeps a copy
          // of a link that is dead by the weekend, and nothing reports a
          // problem, because the row says completed.
          //
          // Owner ruling: "the storage of files, images, videos, etc. are to be
          // stored on supabase buckets." A vendor URL in video_url is not that.
          //
          // FAIL CLOSED instead (CLAUDE.md §4 — "nobody checked" must never
          // render as "checked and fine"): if we could not host the bytes, the
          // render is NOT complete. The row stays `generating`, retry_count is
          // bumped, and the next tick — three minutes away, inside D-ID's own
          // 24-48h window — tries the download again. Nothing fans out, so
          // nothing carries the expiring URL. didResultUrl is still recorded in
          // provider_metadata (below) so an operator can fetch it by hand.
          //
          // BOUNDED, because a permanently broken bucket must not spin forever:
          // after MAX_PERSIST_ATTEMPTS ticks the row fails loudly with a reason
          // that names storage rather than the provider, which is the true
          // cause. A thumbnail is COSMETIC and is deliberately not part of this
          // gate — a missing poster frame does not justify withholding a video —
          // but it is left NULL rather than pointed at D-ID.
          const MAX_PERSIST_ATTEMPTS = 5
          if (didResultUrl && !persistedVideoUrl) {
            const attempts = (video.retry_count ?? 0) + 1
            const giveUp = attempts >= MAX_PERSIST_ATTEMPTS
            const reason =
              `the D-ID render finished but its bytes could not be stored in our bucket ` +
              `(attempt ${attempts}/${MAX_PERSIST_ATTEMPTS})`
            const { error: holdErr } = await supabase
              .from("ai_video_projects")
              .update({
                status: giveUp ? "failed" : "generating",
                provider_status: "done",
                retry_count: attempts,
                error_message: giveUp
                  ? "The video rendered, but it could not be saved to storage. Please try generating it again."
                  : reason,
                provider_metadata: {
                  ...((video as any).provider_metadata ?? {}),
                  did_result_url:       didResultUrl,
                  did_thumbnail_url:    didThumbnailUrl,
                  persisted_to_storage: false,
                },
              })
              .eq("id", video.id)
            // supabase-js RESOLVES refusals (CLAUDE.md §3) — read the error.
            if (holdErr) {
              console.error(`[poll-did-videos] could not record the persist failure for ${video.id}: ${holdErr.message}`)
            }
            console.error(`[poll-did-videos] ${video.id}: ${reason}${giveUp ? " — giving up" : " — will retry next tick"}`)
            if (giveUp) {
              await recordRenderOutcome(supabase, video.id, video.provider_job_id, {
                status: "failed",
                errorMessage: reason,
              })
              results.failed++
            } else {
              results.still_processing++
            }
            continue
          }

          // Use the branded URL when the overlay succeeded, else the clean
          // re-hosted one. BOTH are objects in our own buckets; there is no
          // third arm, by design.
          const finalVideoUrl = brandedVideoUrl ?? persistedVideoUrl
          const finalThumbnailUrl = persistedThumbnailUrl

          await supabase
            .from("ai_video_projects")
            .update({
              status: "completed",
              provider_status: "done",
              video_url: finalVideoUrl,
              thumbnail_url: finalThumbnailUrl,
              duration_seconds: duration,
              completed_at: new Date().toISOString(),
              error_message: null,
              // Compliance audit trail: which post-render branding steps ran.
              // MLS-bound videos report has_visual_brand_overlay=false on purpose.
              has_visual_brand_overlay: visualOverlayApplied,
              // Preserve original D-ID URL in metadata for reference, plus the
              // clean (un-branded) Supabase URL so an MLS export step can pick
              // it up directly without a second D-ID render.
              provider_metadata: {
                ...((video as any).provider_metadata ?? {}),
                did_result_url:        didResultUrl,
                did_thumbnail_url:     didThumbnailUrl,
                persisted_to_storage:  !!persistedVideoUrl,
                clean_video_url:       persistedVideoUrl ?? null,
                branded_video_url:     brandedVideoUrl,
                visual_overlay_applied: visualOverlayApplied,
                // 'explainer' when the cron composited PIP + background;
                // 'standard' when it ran the single-talking-head pipeline.
                render_mode:
                  (video as any).background_type === "video" &&
                  typeof (video as any).background_url === "string" &&
                  (video as any).background_url.length > 0
                    ? "explainer"
                    : "standard",
              },
            })
            .eq("id", video.id)

          // ─── Playbook → capture-page attach ─────────────────────────────
          // Playbook-installed presentation videos carry lead_magnet_id in
          // provider_metadata — the finished render lands on the magnet's
          // public /lm page (landing_content.videoUrl). Best-effort.
          try {
            const magnetId = (video as any).provider_metadata?.lead_magnet_id
            if (magnetId && finalVideoUrl) {
              const { data: magnet } = await supabase
                .from("lead_capture_forms").select("id, landing_content").eq("id", magnetId).maybeSingle()
              if (magnet) {
                await supabase.from("lead_capture_forms").update({
                  landing_content: {
                    ...((magnet as any).landing_content ?? {}),
                    videoUrl: finalVideoUrl,
                    videoProjectId: video.id,
                  },
                }).eq("id", magnetId)
                console.log(`[poll-did-videos] playbook video attached to magnet ${magnetId}`)
              }
            }
          } catch (e) {
            console.error("[poll-did-videos] magnet attach failed:", (e as Error).message)
          }

          // ─── Avatar → Remotion handoff ──────────────────────────────────
          // If this D-ID video was requested as the avatar track for a Remotion
          // composition (provider_metadata.target_composition_id), enqueue that
          // composition render now with the avatar URL wired into input_props.
          // Closes the D-ID → Remotion link; the composition-render-queue cron
          // renders it. Best-effort — a handoff failure must not fail polling.
          try {
            const { enqueueAvatarCompositionForProject } = await import("@/lib/video/avatar-render-orchestrator")
            const handoff = await enqueueAvatarCompositionForProject(video.id, supabase)
            if (handoff.ok) console.log(`[poll-did-videos] avatar→remotion render queued: ${handoff.renderId}`)
          } catch (e) {
            console.error("[poll-did-videos] avatar→remotion handoff failed:", (e as Error).message)
          }

          await recordRenderOutcome(supabase, video.id, video.provider_job_id, {
            status: "completed",
            errorMessage: null,
            renderDurationSeconds: duration ?? null,
          })

          // Notify agent — schema: user_id, brokerage_id, type, title, body, entity_type, entity_id
          if (agentUserId) {
            await supabase.from("notifications").insert({
              user_id: agentUserId,
              brokerage_id: video.brokerage_id,
              type: "video_ready",
              title: "Video Ready",
              body: `Your ${video.video_type ?? "video"} is ready to view and share.`,
              entity_type: "video_project",
              entity_id: video.id,
              priority: "medium",
              channel: "in_app",
            })
          }

          await processKernelEvent({
            event: KernelEvent.VIDEO_GENERATION_COMPLETED,
            brokerageId: video.brokerage_id ?? undefined,
            entityType: "video_project",
            entityId: video.id,
          }).catch((err) => console.error("[poll-did-videos] Kernel event failed:", err))

          // ─── Terminal announcements: fan-out + inter-manager bus ────────────
          // DEFER BOTH when a composite is pending: if this D-ID job is just the AVATAR
          // TRACK for a Remotion composition (target_composition_id), the FINAL deliverable
          // is the branded composite (bookends + QR) that render-composition produces, and
          // it announces on ITS completion. Announcing here would deliver the un-branded cut.
          //
          // The coordination publish already deferred; the video.generated fan-out did NOT,
          // so every hybrid avatar→Remotion video was drafted into email, SMS, social and
          // campaign assets pointing at the raw avatar clip minutes before the branded
          // composite existed. Both now defer together, on the same condition.
          //
          // ONE SPELLING OF THE QUESTION (§6). This was an inline
          // `!!meta.target_composition_id` here and nowhere else, so the email
          // backfill and lib/video/playable-video — which face the exact same
          // window — had no way to ask it. It is now the shared predicate that
          // lib/video/avatar-render-orchestrator owns beside the key it reads.
          const { declaresAvatarComposition } = await import("@/lib/video/avatar-render-orchestrator")
          const hasPendingComposite = declaresAvatarComposition(video.provider_metadata)
          if (!hasPendingComposite) {
            // Emit orchestrator event so handleVideoGenerated fans the finished video out
            // to email + SMS drafts, the listing page, social drafts and campaign assets.
            // NO URL is passed: the handler resolves the playable URL from the row through
            // lib/video/playable-video, so the drafts carry the BRANDED, bucket-hosted cut
            // rather than whatever snapshot was true at emit time.
            if (video.brokerage_id) {
              await emitEventFromCron({
                brokerage_id: video.brokerage_id,
                user_id:      agentUserId ?? undefined,
                event_type:   "video.generated",
                source:       "system",
                dedupe_key:   `video.generated:${video.id}`,
                payload: {
                  video_id:              video.id,
                  video_type:            video.video_type,
                  listing_id:            (video as any).listing_id ?? null,
                  contact_id:            (video as any).contact_id ?? null,
                  marketing_campaign_id: (video as any).marketing_campaign_id ?? null,
                  agent_user_id:         agentUserId ?? null,
                },
              }).catch((err) => console.error("[poll-did-videos] Orchestrator event failed:", err))
            }

            // Fast coordinated path — Asset Manager → Campaign Orchestrator (distribute,
            // always) + Ads Manager (promote, promotable kinds only). Deduped per
            // ai_video_project so re-polling never re-signals; coexists idempotently with
            // the polling crons (listing-promo-social-publish) as a safety net.
            try {
              const { publishVideoCoordinationSignals } = await import("@/lib/kernel/video-coordination")
              await publishVideoCoordinationSignals(video.id, supabase)
            } catch (e) {
              console.error("[poll-did-videos] video-coordination publish failed:", (e as Error).message)
            }
          }

          results.completed++
        } else if (didStatus === "error" || didStatus === "rejected") {
          // Structured {kind, description} → something the agent can act on.
          const errorMsg: string = classifyDidError(null, data.error ?? data).userMessage
          const retryCount = video.retry_count ?? 0

          await supabase
            .from("ai_video_projects")
            .update({
              status: "failed",
              provider_status: didStatus,
              error_message: errorMsg,
              retry_count: retryCount + 1,
            })
            .eq("id", video.id)

          await recordRenderOutcome(supabase, video.id, video.provider_job_id, {
            status: "failed",
            errorMessage: errorMsg,
          })

          if (agentUserId) {
            await supabase.from("notifications").insert({
              user_id: agentUserId,
              brokerage_id: video.brokerage_id,
              type: "video_failed",
              title: "Video Generation Failed",
              body: `Your video could not be generated: ${errorMsg}`,
              entity_type: "video_project",
              entity_id: video.id,
              priority: "high",
              channel: "in_app",
            })
          }

          // ─── Inter-manager bus: Asset Manager escalates the failed render ──
          // A failed/rejected render is never invisible — Asset Manager →
          // Campaign Orchestrator (video_compliance_failed) routes it to the
          // responsible agent + brokerage managers. Deduped per ai_video_project.
          try {
            const { publishVideoCoordinationSignals } = await import("@/lib/kernel/video-coordination")
            await publishVideoCoordinationSignals(video.id, supabase)
          } catch (e) {
            console.error("[poll-did-videos] video-coordination escalation failed:", (e as Error).message)
          }

          results.failed++
        } else {
          // status: created | started | submitted — keep waiting
          results.still_processing++
        }
      } catch (err: any) {
        console.error(`[poll-did-videos] Error processing video ${video.id}:`, err)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: results.processed,
      output_count: results.completed,
      metadata: results,
    })

    return NextResponse.json({ success: true, timestamp: new Date().toISOString(), results })
  } catch (error: any) {
    console.error("[poll-did-videos] Cron error:", error)
    await recordCronFailureAction({ context_id: contextId, error, stage: "main-processing" })
    return NextResponse.json(
      { error: "Polling failed", details: error.message, context_id: contextId },
      { status: 500 }
    )
  }
}
