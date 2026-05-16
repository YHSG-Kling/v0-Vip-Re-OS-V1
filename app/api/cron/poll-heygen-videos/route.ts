import {
type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

const HEYGEN_API_BASE = "https://api.heygen.com/v2"
const MAX_RETRIES = 3

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Run every 5 minutes to check HeyGen video status
export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "poll-heygen-videos",
    cron_path: "/app/api/cron/poll-heygen-videos/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[PollHeygenVideos] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = await createClient()
    const heygenApiKey = process.env.HEYGEN_API_KEY

    if (!heygenApiKey) {
      return NextResponse.json({
        success: false,
        message: "HeyGen API key not configured",
        processed: 0,
      })
    }

    // Get all videos that are currently generating
    const { data: pendingVideos, error: fetchError } = await supabase
      .from("ai_video_projects")
      .select("*")
      .eq("heygen_status", "generating")
      .not("heygen_video_id", "is", null)
      .limit(20)

    if (fetchError) {
      console.error("[v0] Error fetching pending videos:", fetchError)
      throw fetchError
    }

    const results = {
      processed: 0,
      completed: 0,
      failed: 0,
      retried: 0,
      still_processing: 0,
    }

    for (const video of pendingVideos || []) {
      results.processed++

      try {
        // Check status with HeyGen
        const statusResponse = await fetch(`${HEYGEN_API_BASE}/video_status.get?video_id=${video.heygen_video_id}`, {
          headers: {
            "X-Api-Key": heygenApiKey,
          },
        })

        const statusData = await statusResponse.json()

        if (!statusResponse.ok) {
          console.error(`[v0] HeyGen status check failed for ${video.id}:`, statusData)
          continue
        }

        const heygenStatus = statusData.data?.status
        const videoUrl = statusData.data?.video_url
        const thumbnailUrl = statusData.data?.thumbnail_url
        const duration = statusData.data?.duration

        if (heygenStatus === "completed") {
          // Video is ready
          await supabase
            .from("ai_video_projects")
            .update({
              heygen_status: "completed",
              video_url: videoUrl,
              thumbnail_url: thumbnailUrl,
              duration_seconds: duration,
              completed_at: new Date().toISOString(),
              video_metadata: {
                duration_seconds: duration,
                resolution: "1920x1080",
                completed_at: new Date().toISOString(),
              },
            })
            .eq("id", video.id)

          // Update queue
          await supabase
            .from("video_generation_queue")
            .update({
              status: "completed",
              completed_at: new Date().toISOString(),
            })
            .eq("video_project_id", video.id)

          // Send notification to agent
          if (video.agent_id) {
            await supabase.from("notifications").insert({
              user_id: video.agent_id,
              type: "video_ready",
              title: "Video Ready",
              message: `Your ${video.video_type || "video"} is ready to view and share.`,
              related_type: "video",
              related_id: video.id,
              data: { video_url: videoUrl, thumbnail_url: thumbnailUrl },
            })
          }

          results.completed++
        } else if (heygenStatus === "failed") {
          const retryCount = video.retry_count || 0

          if (retryCount < MAX_RETRIES) {
            // Retry the video generation
            const retryResponse = await fetch(`${HEYGEN_API_BASE}/video/generate`, {
              method: "POST",
              headers: {
                "X-Api-Key": heygenApiKey,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                video_inputs: [
                  {
                    character: {
                      type: "avatar",
                      avatar_id: video.heygen_avatar_id,
                      avatar_style: "normal",
                    },
                    voice: {
                      type: "text",
                      input_text: video.script_content,
                      voice_id: video.heygen_voice_id,
                    },
                  },
                ],
                dimension: { width: 1920, height: 1080 },
              }),
            })

            if (retryResponse.ok) {
              const retryData = await retryResponse.json()
              await supabase
                .from("ai_video_projects")
                .update({
                  heygen_video_id: retryData.data?.video_id,
                  heygen_status: "generating",
                  retry_count: retryCount + 1,
                  error_message: null,
                })
                .eq("id", video.id)

              results.retried++
            } else {
              await supabase
                .from("ai_video_projects")
                .update({
                  heygen_status: "failed",
                  error_message: statusData.data?.error || "HeyGen generation failed after retries",
                  retry_count: retryCount + 1,
                })
                .eq("id", video.id)

              results.failed++
            }
          } else {
            await supabase
              .from("ai_video_projects")
              .update({
                heygen_status: "failed",
                error_message: "Max retries exceeded",
              })
              .eq("id", video.id)

            await supabase
              .from("video_generation_queue")
              .update({
                status: "failed",
                failed_at: new Date().toISOString(),
                error_message: "Max retries exceeded",
              })
              .eq("video_project_id", video.id)

            results.failed++
          }
        } else {
          results.still_processing++
        }
      } catch (err: any) {
        console.error(`[v0] Error processing video ${video.id}:`, err)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: results.processed,
      output_count: results.completed,
      metadata: results,
    })

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      results,
    })
  } catch (error: any) {
    console.error("[PollHeygenVideos] Cron error:", error)
    await recordCronFailureAction({ context_id: contextId, error, stage: "main-processing" })
    return NextResponse.json({ error: "Polling failed", details: error.message, context_id: contextId }, { status: 500 })
  }
}
