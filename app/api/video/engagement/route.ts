import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

// ============================================
// LAYER 8.5 VIDEO ENGAGEMENT TRACKING API
// ============================================

// Supported event types for video_engagement_events
const VALID_EVENT_TYPES = [
  "view",
  "pause",
  "complete",
  "click",
  "share",
  "lead_capture",
  "cta_click",
  "replay",
] as const

type VideoEventType = (typeof VALID_EVENT_TYPES)[number]

// Threshold constants for high/low performer detection
const PERFORMANCE_THRESHOLDS = {
  HIGH_PERFORMER: {
    minViews: 100,
    minCompletionRate: 70,
    minClickThroughRate: 5,
  },
  LOW_PERFORMER: {
    minViews: 50, // Only check after enough views
    maxCompletionRate: 20,
    maxClickThroughRate: 1,
  },
}

// GET: Fetch video engagement events and performance tracking
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const videoAssetId = searchParams.get("videoAssetId")
    const videoProjectId = searchParams.get("videoProjectId")
    const contactId = searchParams.get("contactId")
    const brokerageId = searchParams.get("brokerageId")

    const supabase = await createClient()

    // If specific video asset requested, return its engagement events
    if (videoAssetId) {
      const { data: events, error: eventsError } = await supabase
        .from("video_engagement_events")
        .select("*")
        .eq("video_asset_id", videoAssetId)
        .order("timestamp", { ascending: false })
        .limit(100)

      if (eventsError) throw eventsError

      // Get aggregate tracking data
      const { data: tracking, error: trackingError } = await supabase
        .from("video_performance_tracking")
        .select("*")
        .eq("video_asset_id", videoAssetId)
        .maybeSingle()

      if (trackingError) throw trackingError

      return NextResponse.json({
        success: true,
        events: events || [],
        tracking: tracking || null,
      })
    }

    // If video project requested, return its performance data
    if (videoProjectId) {
      const { data: tracking, error: trackingError } = await supabase
        .from("video_performance_tracking")
        .select("*")
        .eq("video_project_id", videoProjectId)
        .maybeSingle()

      if (trackingError) throw trackingError

      return NextResponse.json({
        success: true,
        tracking: tracking || null,
      })
    }

    // If contact requested, return their engagement events
    if (contactId) {
      const { data: events, error: eventsError } = await supabase
        .from("video_engagement_events")
        .select(`
          *,
          video_assets(id, title, category)
        `)
        .eq("contact_id", contactId)
        .order("timestamp", { ascending: false })
        .limit(50)

      if (eventsError) throw eventsError

      return NextResponse.json({
        success: true,
        events: events || [],
      })
    }

    // If brokerage requested, return aggregate performance data
    if (brokerageId) {
      const { data: tracking, error: trackingError } = await supabase
        .from("video_performance_tracking")
        .select("*")
        .eq("brokerage_id", brokerageId)
        .order("total_views", { ascending: false })
        .limit(50)

      if (trackingError) throw trackingError

      return NextResponse.json({
        success: true,
        videos: tracking || [],
      })
    }

    return NextResponse.json(
      { success: false, error: "videoAssetId, videoProjectId, contactId, or brokerageId is required" },
      { status: 400 }
    )
  } catch (error: any) {
    console.error("[v0] Error fetching video engagement:", error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

// POST: Record a video engagement event and update aggregates
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const {
      videoAssetId,
      videoProjectId,
      brokerageId,
      contactId,
      eventType,
      watchDurationSeconds,
      metadata,
    } = body

    // Validate required fields
    if (!eventType || !VALID_EVENT_TYPES.includes(eventType)) {
      return NextResponse.json(
        { 
          success: false, 
          error: `Invalid event_type. Must be one of: ${VALID_EVENT_TYPES.join(", ")}` 
        },
        { status: 400 }
      )
    }

    if (!videoAssetId && !videoProjectId) {
      return NextResponse.json(
        { success: false, error: "videoAssetId or videoProjectId is required" },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    // 1. Insert raw event into video_engagement_events
    const eventRecord = {
      video_asset_id: videoAssetId || null,
      contact_id: contactId || null,
      event_type: eventType as VideoEventType,
      watch_duration_seconds: watchDurationSeconds || 0,
      timestamp: new Date().toISOString(),
    }

    const { data: insertedEvent, error: eventError } = await supabase
      .from("video_engagement_events")
      .insert(eventRecord)
      .select()
      .single()

    if (eventError) {
      console.error("[v0] Error inserting video engagement event:", eventError)
      throw eventError
    }

    // 2. Aggregate metrics into video_performance_tracking
    const trackingResult = await aggregateVideoPerformance(
      supabase,
      videoAssetId,
      videoProjectId,
      brokerageId,
      eventType as VideoEventType,
      watchDurationSeconds
    )

    // 3. Check thresholds and fire kernel events
    if (trackingResult && brokerageId) {
      await checkPerformanceThresholds(supabase, trackingResult, brokerageId)
    }

    return NextResponse.json({
      success: true,
      event: insertedEvent,
      tracking: trackingResult,
    })
  } catch (error: any) {
    console.error("[v0] Error recording video engagement:", error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}

// Helper: Aggregate event into video_performance_tracking
async function aggregateVideoPerformance(
  supabase: any,
  videoAssetId: string | null,
  videoProjectId: string | null,
  brokerageId: string | null,
  eventType: VideoEventType,
  watchDurationSeconds: number = 0
) {
  // Find or create tracking record
  let query = supabase.from("video_performance_tracking").select("*")

  if (videoAssetId) {
    query = query.eq("video_asset_id", videoAssetId)
  } else if (videoProjectId) {
    query = query.eq("video_project_id", videoProjectId)
  } else {
    return null
  }

  const { data: existing, error: fetchError } = await query.maybeSingle()

  if (fetchError) {
    console.error("[v0] Error fetching video performance tracking:", fetchError)
    return null
  }

  // Calculate updates based on event type
  const updates: Record<string, any> = {
    last_event_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  if (existing) {
    // Update existing record
    switch (eventType) {
      case "view":
        updates.total_views = (existing.total_views || 0) + 1
        // For unique views, we'd need to track by contact_id - simplified for now
        updates.unique_views = (existing.unique_views || 0) + 1
        break
      case "complete":
        // Update completion rate
        const totalViews = (existing.total_views || 1)
        const completions = Math.floor((existing.average_completion_rate || 0) * totalViews / 100) + 1
        updates.average_completion_rate = Math.round((completions / totalViews) * 100)
        break
      case "click":
      case "cta_click":
        // Update click-through rate
        const views = existing.total_views || 1
        const clicks = Math.floor((existing.click_through_rate || 0) * views / 100) + 1
        updates.click_through_rate = Math.round((clicks / views) * 100)
        break
      case "share":
        // Update share rate
        const viewsForShare = existing.total_views || 1
        const shares = Math.floor((existing.share_rate || 0) * viewsForShare / 100) + 1
        updates.share_rate = Math.round((shares / viewsForShare) * 100)
        break
      case "lead_capture":
        updates.lead_conversions = (existing.lead_conversions || 0) + 1
        // Estimate ROI based on lead conversions
        updates.estimated_roi = (updates.lead_conversions || existing.lead_conversions || 0) * 500 // $500 estimated value per lead
        break
    }

    // Update watch time for all events that have duration
    if (watchDurationSeconds > 0) {
      updates.total_watch_time_seconds = (existing.total_watch_time_seconds || 0) + watchDurationSeconds
      const totalViews = updates.total_views || existing.total_views || 1
      updates.average_watch_time_seconds = Math.round(
        (updates.total_watch_time_seconds || existing.total_watch_time_seconds || 0) / totalViews
      )
    }

    const { data: updated, error: updateError } = await supabase
      .from("video_performance_tracking")
      .update(updates)
      .eq("id", existing.id)
      .select()
      .single()

    if (updateError) {
      console.error("[v0] Error updating video performance tracking:", updateError)
      return existing
    }

    return updated
  } else {
    // Create new tracking record
    const newRecord = {
      video_asset_id: videoAssetId || null,
      video_project_id: videoProjectId || null,
      brokerage_id: brokerageId || null,
      total_views: eventType === "view" ? 1 : 0,
      unique_views: eventType === "view" ? 1 : 0,
      total_watch_time_seconds: watchDurationSeconds || 0,
      average_watch_time_seconds: watchDurationSeconds || 0,
      average_completion_rate: eventType === "complete" ? 100 : 0,
      click_through_rate: eventType === "click" || eventType === "cta_click" ? 100 : 0,
      share_rate: eventType === "share" ? 100 : 0,
      lead_conversions: eventType === "lead_capture" ? 1 : 0,
      estimated_roi: eventType === "lead_capture" ? 500 : 0,
      last_event_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    const { data: created, error: createError } = await supabase
      .from("video_performance_tracking")
      .insert(newRecord)
      .select()
      .single()

    if (createError) {
      console.error("[v0] Error creating video performance tracking:", createError)
      return null
    }

    return created
  }
}

// Helper: Check thresholds and fire kernel events
async function checkPerformanceThresholds(
  supabase: any,
  tracking: any,
  brokerageId: string
) {
  const totalViews = tracking.total_views || 0
  const completionRate = tracking.average_completion_rate || 0
  const clickThroughRate = tracking.click_through_rate || 0

  // Always fire VIDEO_PERFORMANCE_UPDATED
  await supabase.from("lifecycle_events").insert({
    entity_type: "video_performance",
    entity_id: tracking.id,
    brokerage_id: brokerageId,
    event_type: KernelEvent.VIDEO_PERFORMANCE_UPDATED,
    metadata: {
      total_views: totalViews,
      completion_rate: completionRate,
      click_through_rate: clickThroughRate,
      video_asset_id: tracking.video_asset_id,
      video_project_id: tracking.video_project_id,
    },
  })

  await processKernelEvent({
    event: KernelEvent.VIDEO_PERFORMANCE_UPDATED,
    brokerageId,
    entityType: "video_performance",
    entityId: tracking.id,
  }).catch(err => console.error("[v0] Kernel event failed:", err))

  // Check for high performer
  if (
    totalViews >= PERFORMANCE_THRESHOLDS.HIGH_PERFORMER.minViews &&
    completionRate >= PERFORMANCE_THRESHOLDS.HIGH_PERFORMER.minCompletionRate &&
    clickThroughRate >= PERFORMANCE_THRESHOLDS.HIGH_PERFORMER.minClickThroughRate
  ) {
    await supabase.from("lifecycle_events").insert({
      entity_type: "video_performance",
      entity_id: tracking.id,
      brokerage_id: brokerageId,
      event_type: KernelEvent.VIDEO_HIGH_PERFORMER_DETECTED,
      metadata: {
        total_views: totalViews,
        completion_rate: completionRate,
        click_through_rate: clickThroughRate,
        thresholds: PERFORMANCE_THRESHOLDS.HIGH_PERFORMER,
      },
    })

    await processKernelEvent({
      event: KernelEvent.VIDEO_HIGH_PERFORMER_DETECTED,
      brokerageId,
      entityType: "video_performance",
      entityId: tracking.id,
    }).catch(err => console.error("[v0] Kernel event failed:", err))
  }

  // Check for low performer
  if (
    totalViews >= PERFORMANCE_THRESHOLDS.LOW_PERFORMER.minViews &&
    completionRate <= PERFORMANCE_THRESHOLDS.LOW_PERFORMER.maxCompletionRate &&
    clickThroughRate <= PERFORMANCE_THRESHOLDS.LOW_PERFORMER.maxClickThroughRate
  ) {
    await supabase.from("lifecycle_events").insert({
      entity_type: "video_performance",
      entity_id: tracking.id,
      brokerage_id: brokerageId,
      event_type: KernelEvent.VIDEO_LOW_PERFORMER_DETECTED,
      metadata: {
        total_views: totalViews,
        completion_rate: completionRate,
        click_through_rate: clickThroughRate,
        thresholds: PERFORMANCE_THRESHOLDS.LOW_PERFORMER,
      },
    })

    await processKernelEvent({
      event: KernelEvent.VIDEO_LOW_PERFORMER_DETECTED,
      brokerageId,
      entityType: "video_performance",
      entityId: tracking.id,
    }).catch(err => console.error("[v0] Kernel event failed:", err))
  }
}
