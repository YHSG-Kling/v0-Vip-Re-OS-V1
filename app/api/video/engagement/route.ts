import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
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

// GET: Fetch video engagement events and performance tracking (requires auth)
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const { searchParams } = new URL(request.url)
    const videoAssetId = searchParams.get("videoAssetId")
    const videoProjectId = searchParams.get("videoProjectId")
    const contactId = searchParams.get("contactId")
    // Always use session-resolved brokerage — never trust caller-supplied value
    const brokerageId = auth.brokerageId

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
//
// TENANCY. The tenant is resolved from the SESSION and from nowhere else. The
// previous shape of this handler had no auth gate at all and read the tenant id
// out of the JSON body — the caller got to NAME the brokerage it wanted its
// event, its aggregate row and its lifecycle_events row written into. That is
// the whole defect class: an unauthenticated body naming a tenant is a write
// primitive into any tenant on the platform.
//
// Three things close it, and all three are needed:
//   1. requireAuth on the POST path (not merely imported for GET's benefit).
//   2. The tenant comes from auth.brokerageId. A body that still carries one is
//      REFUSED with 400 rather than silently ignored — a caller that thinks it
//      is choosing a tenant must be told it is not, and a silent ignore is
//      indistinguishable from the old behaviour in a test.
//   3. The NAMED VIDEO is verified into that tenant before anything is written.
//      Without (3), (1) and (2) only move the lie: a caller in brokerage A
//      could stamp its own tenant onto engagement for brokerage B's video and
//      corrupt both ledgers at once.
export async function POST(request: Request) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  // Session-resolved tenant. Never read from the request body.
  const brokerageId = auth.brokerageId

  try {
    const body = await request.json()
    const {
      videoAssetId,
      videoProjectId,
      contactId,
      eventType,
      watchDurationSeconds,
    } = body

    // A caller-supplied tenant is refused outright, not quietly dropped.
    if (body && Object.prototype.hasOwnProperty.call(body, "brokerageId")) {
      return NextResponse.json(
        {
          success: false,
          error: "brokerageId is not accepted in the request body — the tenant is resolved from the session",
        },
        { status: 400 }
      )
    }

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

    // The named video must belong to the session's tenant. Both tables carry
    // brokerage_id, so this is an equality test against a resolved value — not
    // an FK, which would only prove the row exists somewhere.
    const owned = await assertVideoBelongsToTenant(
      supabase,
      videoAssetId || null,
      videoProjectId || null,
      brokerageId
    )
    if (!owned.ok) {
      return NextResponse.json({ success: false, error: owned.error }, { status: owned.status })
    }

    // 1. Insert raw event into video_engagement_events — STAMPED with the
    //    session tenant. This column exists and was previously left null on
    //    every row, so the raw event ledger had no tenant at all.
    const eventRecord = {
      brokerage_id: brokerageId,
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
    if (trackingResult) {
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

// Helper: prove the named video asset / project sits inside the caller's tenant.
// Reads are error-checked: supabase-js RESOLVES a rejected query, so an
// unchecked read would turn a refusal into "no such row" and, worse, a missing
// `error` check plus a null row would read as "not ours" or "ours" by accident.
async function assertVideoBelongsToTenant(
  supabase: any,
  videoAssetId: string | null,
  videoProjectId: string | null,
  brokerageId: string
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (videoAssetId) {
    const { data: asset, error: assetError } = await supabase
      .from("video_assets")
      .select("id, brokerage_id")
      .eq("id", videoAssetId)
      .maybeSingle()
    if (assetError) return { ok: false, error: assetError.message, status: 500 }
    if (!asset) return { ok: false, error: "Video asset not found", status: 404 }
    if (asset.brokerage_id !== brokerageId) {
      return { ok: false, error: "Video asset does not belong to your brokerage", status: 403 }
    }
  }

  if (videoProjectId) {
    const { data: project, error: projectError } = await supabase
      .from("ai_video_projects")
      .select("id, brokerage_id")
      .eq("id", videoProjectId)
      .maybeSingle()
    if (projectError) return { ok: false, error: projectError.message, status: 500 }
    if (!project) return { ok: false, error: "Video project not found", status: 404 }
    if (project.brokerage_id !== brokerageId) {
      return { ok: false, error: "Video project does not belong to your brokerage", status: 403 }
    }
  }

  return { ok: true }
}

// Helper: Aggregate event into video_performance_tracking
async function aggregateVideoPerformance(
  supabase: any,
  videoAssetId: string | null,
  videoProjectId: string | null,
  brokerageId: string,
  eventType: VideoEventType,
  watchDurationSeconds: number = 0
) {
  // Find or create tracking record. Scoped to the session tenant as well as the
  // video id: the aggregate row is a tenant-owned row, and a lookup on the video
  // id alone would let one tenant's event land on another tenant's aggregate.
  let query = supabase
    .from("video_performance_tracking")
    .select("*")
    .eq("brokerage_id", brokerageId)

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
      brokerage_id: brokerageId,
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

  // THE OWNER'S VIRAL RULE — "if the video goes viral using that script, it
  // should be shared to the whole brokerage." Wired into the two lanes that
  // already evaluate thresholds off these same aggregates, not onto a new path.
  //
  // Note what is NOT passed. This used to be justified by the POST handler
  // having no auth gate and taking its tenant from the request body; that is no
  // longer true — POST is session-gated and the tenant is resolved from the
  // session (see the header note on this handler). The promoter still takes the
  // project id ALONE, and still re-resolves the view count, the video's tenant
  // and the script's tenant from the database itself, because that is the right
  // shape regardless of who calls it: an argument surface too small to lie
  // through cannot be talked into promoting the wrong script, and this module
  // has a second caller (the video-generation server action) too. It also
  // refuses a video/script tenant mismatch outright. Non-fatal: the engagement
  // event has already been recorded and must not be lost to a failed promotion.
  if (tracking.video_project_id) {
    const { shareViralScriptWithBrokerage } = await import("@/lib/video/viral-script-share")
    await shareViralScriptWithBrokerage(tracking.video_project_id).catch(err =>
      console.error("[v0] viral script share failed:", err),
    )
  }
}
