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
import { createClient } from "@/lib/supabase/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import { emitEventFromCron } from "@/app/actions/orchestrator"
import { verifyCronAuth } from "@/lib/cron-auth"

const DID_API_BASE = "https://api.d-id.com"

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
    const supabase = await createClient()
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
      .select("id, agent_id, brokerage_id, listing_id, contact_id, marketing_campaign_id, provider_job_id, provider_metadata, status, retry_count, video_type, usage_intent, background_type, background_url, intro_video_url, outro_video_url")
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
        const mode = (video.provider_metadata as any)?.mode === "clip" ? "clips" : "talks"
        const statusRes = await fetch(`${DID_API_BASE}/${mode}/${video.provider_job_id}`, {
          headers: { Authorization: auth, Accept: "application/json" },
        })

        if (!statusRes.ok) {
          // Skip on transient API error — try again next cron tick
          continue
        }

        const data = await statusRes.json()
        const didStatus: string = data.status

        if (didStatus === "done") {
          const didResultUrl: string | null = data.result_url ?? null
          const didThumbnailUrl: string | null = data.thumbnail_url ?? null
          const duration: number | null =
            typeof data.duration === "number" ? Math.round(data.duration) : null

          // ─── Persist video to Supabase Storage ─────────────────────────────
          // D-ID result URLs are signed and expire in ~24–48h. Download immediately
          // and store in our own bucket so emails, newsletters, and portals can
          // embed a durable URL that never expires.
          let persistedVideoUrl: string | null = null
          let persistedThumbnailUrl: string | null = null

          if (didResultUrl) {
            try {
              const agentFolder = video.agent_id ?? "shared"
              const videoPath = `agent-videos/${agentFolder}/${video.id}.mp4`

              const videoFetch = await fetch(didResultUrl)
              if (videoFetch.ok) {
                const videoBuffer = await videoFetch.arrayBuffer()
                const { error: uploadErr } = await supabase.storage
                  .from("listing-media")
                  .upload(videoPath, videoBuffer, {
                    contentType: "video/mp4",
                    upsert: true,
                  })
                if (!uploadErr) {
                  const { data: { publicUrl } } = supabase.storage
                    .from("listing-media")
                    .getPublicUrl(videoPath)
                  persistedVideoUrl = publicUrl
                } else {
                  console.error("[poll-did-videos] Storage upload failed:", uploadErr)
                }
              }
            } catch (storageErr: any) {
              // Non-fatal — fall back to D-ID URL if storage fails
              console.error("[poll-did-videos] Video persist failed:", storageErr.message)
            }
          }

          if (didThumbnailUrl) {
            try {
              const agentFolder = video.agent_id ?? "shared"
              const thumbPath = `agent-videos/${agentFolder}/${video.id}-thumb.jpg`

              const thumbFetch = await fetch(didThumbnailUrl)
              if (thumbFetch.ok) {
                const thumbBuffer = await thumbFetch.arrayBuffer()
                const { error: thumbErr } = await supabase.storage
                  .from("listing-media")
                  .upload(thumbPath, thumbBuffer, {
                    contentType: "image/jpeg",
                    upsert: true,
                  })
                if (!thumbErr) {
                  const { data: { publicUrl } } = supabase.storage
                    .from("listing-media")
                    .getPublicUrl(thumbPath)
                  persistedThumbnailUrl = publicUrl
                }
              }
            } catch { /* thumbnail is non-critical */ }
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

              const { compositeVideoAttribution, compositeExplainerVideo, concatIntroOutro } =
                await import("@/lib/video/composite-attribution")
              let result = isExplainer
                ? await compositeExplainerVideo({
                    backgroundVideoUrl:  (video as any).background_url,
                    talkingHeadVideoUrl: persistedVideoUrl,
                    brand,
                  })
                : await compositeVideoAttribution({
                    inputVideoUrl: persistedVideoUrl,
                    brand,
                  })

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
                const { error: brandedUploadErr } = await supabase.storage
                  .from("listing-media")
                  .upload(brandedPath, result.outputBuffer, {
                    contentType: "video/mp4",
                    upsert: true,
                  })
                if (!brandedUploadErr) {
                  const { data: { publicUrl } } = supabase.storage
                    .from("listing-media")
                    .getPublicUrl(brandedPath)
                  brandedVideoUrl = publicUrl
                  visualOverlayApplied = true
                } else {
                  console.error("[poll-did-videos] Branded upload failed:", brandedUploadErr)
                }
              }
            } catch (overlayErr: any) {
              // Overlay is best-effort — fall back to the un-branded persisted
              // video. Compliance gate will flag the missing visual overlay.
              console.error("[poll-did-videos] Visual overlay failed:", overlayErr?.message ?? overlayErr)
            }
          }

          // Use the branded URL when overlay succeeded → persisted URL → D-ID URL
          const finalVideoUrl = brandedVideoUrl ?? persistedVideoUrl ?? didResultUrl
          const finalThumbnailUrl = persistedThumbnailUrl ?? didThumbnailUrl

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

          await supabase
            .from("video_render_log")
            .update({ render_duration_seconds: duration ?? null })
            .eq("project_id", video.id)
            .eq("provider", "did")

          // Notify agent — schema: user_id, brokerage_id, type, title, body, entity_type, entity_id
          if (video.agent_id) {
            await supabase.from("notifications").insert({
              user_id: video.agent_id,
              brokerage_id: video.brokerage_id,
              type: "video_ready",
              title: "Video Ready",
              body: `Your ${video.video_type ?? "video"} is ready to view and share.`,
              entity_type: "video_project",
              entity_id: video.id,
              priority: "normal",
              channel: "in_app",
            })
          }

          await processKernelEvent({
            event: KernelEvent.VIDEO_GENERATION_COMPLETED,
            brokerageId: video.brokerage_id ?? undefined,
            entityType: "video_project",
            entityId: video.id,
          }).catch((err) => console.error("[poll-did-videos] Kernel event failed:", err))

          // Emit orchestrator event so handleVideoGenerated can auto-draft social posts /
          // personal contact emails based on video_type
          if (video.brokerage_id) {
            await emitEventFromCron({
              brokerage_id: video.brokerage_id,
              user_id:      video.agent_id ?? undefined,
              event_type:   "video.generated",
              source:       "system",
              dedupe_key:   `video.generated:${video.id}`,
              payload: {
                video_id:              video.id,
                video_type:            video.video_type,
                video_url:             persistedVideoUrl ?? didResultUrl ?? null,
                thumbnail_url:         didThumbnailUrl ?? null,
                listing_id:            (video as any).listing_id ?? null,
                contact_id:            (video as any).contact_id ?? null,
                marketing_campaign_id: (video as any).marketing_campaign_id ?? null,
                agent_user_id:         video.agent_id ?? null,
              },
            }).catch((err) => console.error("[poll-did-videos] Orchestrator event failed:", err))
          }

          results.completed++
        } else if (didStatus === "error" || didStatus === "rejected") {
          const errorMsg: string = data.error?.description ?? data.error ?? "D-ID render failed"
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

          if (video.agent_id) {
            await supabase.from("notifications").insert({
              user_id: video.agent_id,
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
