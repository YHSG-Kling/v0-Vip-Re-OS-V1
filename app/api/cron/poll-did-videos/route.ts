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

const DID_API_BASE = "https://api.d-id.com"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

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
      .select("id, agent_id, brokerage_id, listing_id, provider_job_id, provider_metadata, status, retry_count, video_type")
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

          // Use our persisted URL when available; keep D-ID URL as provider fallback
          const finalVideoUrl = persistedVideoUrl ?? didResultUrl
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
              // Preserve original D-ID URL in metadata for reference
              provider_metadata: {
                ...((video as any).provider_metadata ?? {}),
                did_result_url: didResultUrl,
                did_thumbnail_url: didThumbnailUrl,
                persisted_to_storage: !!persistedVideoUrl,
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
                video_id:      video.id,
                video_type:    video.video_type,
                video_url:     persistedVideoUrl ?? didResultUrl ?? null,
                listing_id:    (video as any).listing_id ?? null,
                agent_user_id: video.agent_id ?? null,
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
