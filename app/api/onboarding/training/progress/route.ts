// ============================================================
// SYSTEM: L11-S04 — Training Video Progress API
// VIP Real Estate AI OS — Layer 11
// ============================================================
// Lightweight endpoint for 10-second polling writes during video playback
// Auth-gated, rate limited to 1 write per 5 seconds per agent per video

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { KernelEvent, processKernelEvent } from "@/lib/kernel"

// In-memory rate limiting (per-instance)
// In production, use Redis via Upstash for distributed rate limiting
const rateLimitMap = new Map<string, number>()
const RATE_LIMIT_MS = 5000 // 5 seconds between writes

export async function POST(request: NextRequest) {
  try {
    // Parse request body
    const body = await request.json()
    const { videoId, positionSeconds, percentWatched } = body

    if (!videoId || typeof positionSeconds !== "number" || typeof percentWatched !== "number") {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      )
    }

    // Validate percentWatched is within bounds
    if (percentWatched < 0 || percentWatched > 100) {
      return NextResponse.json(
        { success: false, error: "percentWatched must be between 0 and 100" },
        { status: 400 }
      )
    }

    // Get agent context
    let context
    try {
      context = await getAgentContext()
    } catch {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      )
    }

    // WAVE 155 (lane 155S3): getAgentContext() NEVER throws — an anonymous caller gets the safe default (isAuthenticated false,
    // agentId / brokerageId null), so the catch above never fired and this route wrote a completion row with agent_id NULL and
    // fired TRAINING_VIDEO_COMPLETED / TRAINING_COURSE_COMPLETED with an empty tenant for anyone who POSTed. The guard is
    // opt-in (lib/identity/get-agent-context.ts:57): it is now applied.
    if (!context.isAuthenticated || !context.agentId || !context.brokerageId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      )
    }

    const { agentId, brokerageId } = context

    // Rate limiting check
    const rateLimitKey = `${agentId}:${videoId}`
    const lastWrite = rateLimitMap.get(rateLimitKey) || 0
    const now = Date.now()

    if (now - lastWrite < RATE_LIMIT_MS) {
      return NextResponse.json(
        { success: true, skipped: true, message: "Rate limited, skipping write" },
        { status: 200 }
      )
    }

    // Update rate limit timestamp
    rateLimitMap.set(rateLimitKey, now)

    // Clean up old entries periodically (prevent memory leak)
    if (rateLimitMap.size > 10000) {
      const cutoff = now - RATE_LIMIT_MS * 2
      for (const [key, timestamp] of rateLimitMap.entries()) {
        if (timestamp < cutoff) {
          rateLimitMap.delete(key)
        }
      }
    }

    // WAVE 156 (lane 156K): the gate above ran first; the writes ride the SERVICE client with the SESSION's agent and tenant
    // pinned on every statement (CLAUDE.md §4), so the row-security write policies on video_completion_tracking can be closed to
    // the browser (owner SQL in the lane report) without breaking this door. The percentWatched the browser sends is a CLAIM: the
    // credited figure is lib/onboarding/certification-engine.ts creditWatchProgress — real time between this server's own writes,
    // against the video's own duration — because the certifications read percent_watched as their evidence.
    const supabase = createServiceClient()
    const { creditWatchProgress, VIDEO_WATCH_COMPLETE_PERCENT } = await import("@/lib/onboarding/certification-engine")
    const isUuidVideo = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(videoId))
    const { data: video, error: videoErr } = isUuidVideo
      ? await supabase.from("training_videos").select("id, duration_seconds").eq("id", videoId).or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`).maybeSingle()
      : { data: null, error: null }
    if (videoErr) return NextResponse.json({ success: false, error: "The training video could not be read" }, { status: 500 })
    if (!video) return NextResponse.json({ success: false, error: "Training video not found" }, { status: 404 })

    // Check if completion record exists — a refused read is not "no record" (it would re-credit from zero), so it refuses.
    const { data: existing, error: existingErr } = await supabase
      .from("video_completion_tracking")
      .select("id, percent_watched, completed, updated_at, created_at")
      .eq("agent_id", agentId)
      .eq("training_video_id", videoId)
      .maybeSingle()
    if (existingErr) return NextResponse.json({ success: false, error: "Your progress could not be read, so it was not recorded" }, { status: 500 })

    const credit = creditWatchProgress({
      durationSeconds: (video as { duration_seconds?: number | null }).duration_seconds,
      claimedPercent: percentWatched,
      prior: existing ? { percentWatched: existing.percent_watched, lastWriteAt: existing.updated_at ?? existing.created_at } : null,
      now: new Date(),
    })
    const wasCompleted = existing?.completed === true
    const shouldComplete = credit.creditedPercent >= VIDEO_WATCH_COMPLETE_PERCENT && !wasCompleted
    const newPercentWatched = credit.creditedPercent

    // WAVE 155 (lane 155R21, LAW 5): ONE receipt per COMPLETION — the call that flips `completed` and fires TRAINING_VIDEO_COMPLETED
    // (and TRAINING_COURSE_COMPLETED) is the consequential act; the 10-second position saves before it are playback telemetry and
    // stay unreceipted (a receipt per poll would double the round trips of a hot poll and bury the ledger). Session user and tenant
    // (CLAUDE.md §4); no key — `wasCompleted` above is the act's own at-most-once. A refusing ledger changes nothing.
    const record = async (): Promise<{ success: boolean; error?: string; allRequiredComplete: boolean }> => {
    if (existing) {
      // Update existing record
      const updateData: Record<string, unknown> = {
        last_position_seconds: positionSeconds,
        percent_watched: newPercentWatched,
        updated_at: new Date().toISOString(),
      }

      if (shouldComplete) {
        updateData.completed = true
        updateData.completed_at = new Date().toISOString()
      }

      const { error: updateError } = await supabase
        .from("video_completion_tracking")
        .update(updateData)
        .eq("id", existing.id)
        .eq("agent_id", agentId)

      if (updateError) {
        console.error("[TrainingAPI] Error updating progress:", updateError)
        return { success: false, error: "Failed to update progress", allRequiredComplete: false }
      }
    } else {
      // Insert new record
      const { error: insertError } = await supabase
        .from("video_completion_tracking")
        .insert({
          agent_id: agentId,
          brokerage_id: brokerageId,
          training_video_id: videoId,
          last_position_seconds: positionSeconds,
          percent_watched: newPercentWatched,
          updated_at: new Date().toISOString(),
          completed: shouldComplete,
          completed_at: shouldComplete ? new Date().toISOString() : null,
        })

      if (insertError) {
        console.error("[TrainingAPI] Error inserting progress:", insertError)
        return { success: false, error: "Failed to record progress", allRequiredComplete: false }
      }
    }

    // Fire kernel events if video was just completed
    let allRequiredComplete = false

    if (shouldComplete) {
      // Fire TRAINING_VIDEO_COMPLETED
      await processKernelEvent({
        event: KernelEvent.TRAINING_VIDEO_COMPLETED,
        brokerageId: brokerageId ?? "",
        entityType: "training_video",
        entityId: videoId,
      })

      // Check if all required videos are now complete
      const { data: allVideos } = await supabase
        .from("training_videos")
        .select("id, is_required")
        .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)

      const requiredVideoIds = (allVideos || [])
        .filter((v) => v.is_required)
        .map((v) => v.id)

      const { data: completedVideos } = await supabase
        .from("video_completion_tracking")
        .select("training_video_id")
        .eq("agent_id", agentId)
        .eq("completed", true)
        .in("training_video_id", requiredVideoIds)

      allRequiredComplete =
        requiredVideoIds.length > 0 &&
        (completedVideos?.length || 0) >= requiredVideoIds.length

      if (allRequiredComplete) {
        // Fire TRAINING_COURSE_COMPLETED
        await processKernelEvent({
          event: KernelEvent.TRAINING_COURSE_COMPLETED,
          brokerageId: brokerageId ?? "",
          entityType: "agent",
          entityId: agentId ?? "",
        })
      }
    }
    return { success: true, allRequiredComplete }
    }
    const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
    const recorded = shouldComplete && context.userId
      ? await ledgerSessionAction({ brokerageId, action: "training.video.complete", actor: { type: "user", userId: context.userId, agentId }, subject: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(videoId)) ? { type: "training_video", id: String(videoId) } : { type: "training_video", ref: String(videoId) }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { percent_watched: newPercentWatched } }, record)
      : await record()
    if (!recorded.success) {
      return NextResponse.json(
        { success: false, error: recorded.error ?? "Failed to record progress" },
        { status: 500 }
      )
    }
    const allRequiredComplete = "allRequiredComplete" in recorded && recorded.allRequiredComplete === true

    return NextResponse.json({
      success: true,
      completed: shouldComplete || wasCompleted,
      allRequiredComplete,
      percentWatched: newPercentWatched,
    })
  } catch (error) {
    console.error("[TrainingAPI] Unexpected error:", error)
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    )
  }
}
