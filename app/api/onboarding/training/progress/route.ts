// ============================================================
// SYSTEM: L11-S04 — Training Video Progress API
// VIP Real Estate AI OS — Layer 11
// ============================================================
// Lightweight endpoint for 10-second polling writes during video playback
// Auth-gated, rate limited to 1 write per 5 seconds per agent per video

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
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

    const supabase = await createClient()

    // Check if completion record exists
    const { data: existing } = await supabase
      .from("video_completion_tracking")
      .select("id, percent_watched, completed")
      .eq("agent_id", agentId)
      .eq("training_video_id", videoId)
      .maybeSingle()

    const wasCompleted = existing?.completed === true
    const shouldComplete = percentWatched >= 90 && !wasCompleted
    const newPercentWatched = Math.max(existing?.percent_watched || 0, percentWatched)

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

      if (updateError) {
        console.error("[TrainingAPI] Error updating progress:", updateError)
        return NextResponse.json(
          { success: false, error: "Failed to update progress" },
          { status: 500 }
        )
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
          percent_watched: percentWatched,
          completed: shouldComplete,
          completed_at: shouldComplete ? new Date().toISOString() : null,
        })

      if (insertError) {
        console.error("[TrainingAPI] Error inserting progress:", insertError)
        return NextResponse.json(
          { success: false, error: "Failed to record progress" },
          { status: 500 }
        )
      }
    }

    // Fire kernel events if video was just completed
    let allRequiredComplete = false

    if (shouldComplete) {
      // Fire TRAINING_VIDEO_COMPLETED
      await processKernelEvent({
        event: KernelEvent.TRAINING_VIDEO_COMPLETED,
        brokerageId,
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
          brokerageId,
          entityType: "agent",
          entityId: agentId,
        })
      }
    }

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
