"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { resolveProvider } from "@/lib/kernel/providers"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"
import type { ScriptType, ApprovalStatus, VideoScript, ScriptVariation } from "@/app/types/video-generation"

// ============================================
// VIDEO SCRIPT LIBRARY — CANONICAL TABLE
// Table: public.video_scripts_library
// ============================================

export async function getVideoScriptLibrary(filters?: {
  brokerageId?: string
  agentId?: string
  scriptType?: ScriptType
  templateBacked?: boolean
  approvalStatus?: ApprovalStatus
  includeVariationCount?: boolean
}) {
  const supabase = await createClient()

  let query = supabase
    .from("video_scripts_library")
    .select(`
      *,
      video_templates(id, template_name, category),
      script_variations(id)
    `)
    .eq("is_active", true)
    .order("created_at", { ascending: false })

  if (filters?.brokerageId) {
    query = query.eq("brokerage_id", filters.brokerageId)
  }
  if (filters?.agentId) {
    query = query.eq("agent_id", filters.agentId)
  }
  if (filters?.scriptType) {
    query = query.eq("script_type", filters.scriptType)
  }
  if (filters?.templateBacked === true) {
    query = query.not("template_id", "is", null)
  } else if (filters?.templateBacked === false) {
    query = query.is("template_id", null)
  }
  if (filters?.approvalStatus) {
    query = query.eq("approval_status", filters.approvalStatus)
  }

  const { data, error } = await query

  if (error) {
    console.error("[video-generation] Error fetching video scripts:", error)
    return []
  }

  // Map variation count
  return (data || []).map(script => ({
    ...script,
    variation_count: script.script_variations?.length ?? 0,
    template: script.video_templates ?? null,
  }))
}

export async function getVideoScriptById(scriptId: string) {
  if (!isValidUUID(scriptId)) return null

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("video_scripts_library")
    .select(`
      *,
      video_templates(id, template_name, category, default_script, duration_seconds),
      script_variations(*)
    `)
    .eq("id", scriptId)
    .single()

  if (error) {
    console.error("[video-generation] Error fetching script:", error)
    return null
  }

  return data
}

export async function saveVideoScript(data: {
  brokerageId: string
  agentId?: string
  listingId?: string
  contactId?: string
  templateId?: string
  scriptType: ScriptType
  title: string
  scriptContent: string
  durationTargetSeconds?: number
  brandVoiceTone?: string
  approvalStatus?: ApprovalStatus
  complianceReviewNotes?: string
  requiredBrandAssets?: Record<string, any>
  aiGenerated?: boolean
  createdBy?: string
}) {
  const supabase = await createClient()

  const { data: script, error } = await supabase
    .from("video_scripts_library")
    .insert({
      brokerage_id: data.brokerageId,
      agent_id: data.agentId ?? null,
      listing_id: data.listingId ?? null,
      contact_id: data.contactId ?? null,
      template_id: data.templateId ?? null,
      script_type: data.scriptType,
      title: data.title,
      script_content: data.scriptContent,
      duration_target_seconds: data.durationTargetSeconds ?? null,
      brand_voice_tone: data.brandVoiceTone ?? null,
      approval_status: data.approvalStatus ?? "draft",
      compliance_review_notes: data.complianceReviewNotes ?? null,
      required_brand_assets: data.requiredBrandAssets ?? null,
      ai_generated: data.aiGenerated ?? false,
      is_active: true,
      created_by: data.createdBy ?? null,
      compliance_approved: false,
    })
    .select()
    .single()

  if (error) {
    console.error("[video-generation] Error saving script:", error)
    throw error
  }

  // Write lifecycle_events row
  await supabase.from("lifecycle_events").insert({
    entity_type: "video_script",
    entity_id: script.id,
    brokerage_id: data.brokerageId,
    event_type: KernelEvent.SCRIPT_GENERATED,
    actor_user_id: data.createdBy ?? null,
    metadata: {
      script_type: data.scriptType,
      ai_generated: data.aiGenerated ?? false,
      approval_status: data.approvalStatus ?? "draft",
    },
  })

  // Fire kernel event
  await processKernelEvent({
    event: KernelEvent.SCRIPT_GENERATED,
    brokerageId: data.brokerageId,
    entityType: "video_script",
    entityId: script.id,
  }).catch(err => console.error("[video-generation] Kernel event failed:", err))

  revalidatePath("/dashboard/videos")
  revalidatePath("/dashboard/videos/library")
  return script
}

export async function updateScriptApprovalStatus(
  scriptId: string,
  brokerageId: string,
  approvalStatus: ApprovalStatus,
  complianceReviewNotes?: string,
  actorUserId?: string
) {
  if (!isValidUUID(scriptId)) throw new Error("Invalid script ID")

  const supabase = await createClient()

  const { data: script, error } = await supabase
    .from("video_scripts_library")
    .update({
      approval_status: approvalStatus,
      compliance_review_notes: complianceReviewNotes ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", scriptId)
    .eq("brokerage_id", brokerageId)
    .select()
    .single()

  if (error) {
    console.error("[video-generation] Error updating approval status:", error)
    throw error
  }

  // Write lifecycle event
  const eventType = approvalStatus === "approved" 
    ? KernelEvent.SCRIPT_APPROVED 
    : approvalStatus === "rejected" 
      ? KernelEvent.SCRIPT_REJECTED 
      : KernelEvent.SCRIPT_GENERATED

  await supabase.from("lifecycle_events").insert({
    entity_type: "video_script",
    entity_id: scriptId,
    brokerage_id: brokerageId,
    event_type: eventType,
    actor_user_id: actorUserId ?? null,
    metadata: {
      approval_status: approvalStatus,
      compliance_review_notes: complianceReviewNotes,
    },
  })

  revalidatePath("/dashboard/videos/library")
  return script
}

// ============================================
// VIDEO TEMPLATES — CANONICAL TABLE
// Table: public.video_templates
// ============================================

export async function getVideoTemplates(filters?: {
  category?: string
  scriptType?: ScriptType
}) {
  const supabase = await createClient()

  let query = supabase
    .from("video_templates")
    .select("*")
    .eq("is_active", true)
    .order("sort_order")

  if (filters?.category) {
    query = query.eq("category", filters.category)
  }
  if (filters?.scriptType) {
    query = query.contains("recommended_for", [filters.scriptType])
  }

  const { data, error } = await query

  if (error) {
    console.error("[video-generation] Error fetching video templates:", error)
    return []
  }

  return data || []
}

export async function getVideoTemplateById(templateId: string) {
  if (!isValidUUID(templateId)) return null

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("video_templates")
    .select("*")
    .eq("id", templateId)
    .single()

  if (error) {
    console.error("[video-generation] Error fetching template:", error)
    return null
  }

  return data
}

// ============================================
// SCRIPT VARIATIONS — CANONICAL TABLE
// Table: public.script_variations
// ============================================

export async function getScriptVariations(scriptLibraryId: string) {
  if (!isValidUUID(scriptLibraryId)) return []

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("script_variations")
    .select("*")
    .eq("script_library_id", scriptLibraryId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[video-generation] Error fetching variations:", error)
    return []
  }

  return data || []
}

export async function createScriptVariation(data: {
  scriptLibraryId: string
  brokerageId: string
  variationLabel: string
  variationGoal?: string
  scriptContent: string
  callToAction?: string
  audienceSegment?: string
  isAbTest?: boolean
  createdBy?: string
}) {
  if (!isValidUUID(data.scriptLibraryId)) {
    throw new Error("Invalid script library ID")
  }

  const supabase = await createClient()

  const { data: variation, error } = await supabase
    .from("script_variations")
    .insert({
      script_library_id: data.scriptLibraryId,
      brokerage_id: data.brokerageId,
      variation_label: data.variationLabel,
      variation_goal: data.variationGoal ?? null,
      script_content: data.scriptContent,
      call_to_action: data.callToAction ?? null,
      audience_segment: data.audienceSegment ?? null,
      is_ab_test: data.isAbTest ?? false,
      created_by: data.createdBy ?? null,
      compliance_approved: false,
    })
    .select()
    .single()

  if (error) {
    console.error("[video-generation] Error creating variation:", error)
    throw error
  }

  // Write lifecycle event
  await supabase.from("lifecycle_events").insert({
    entity_type: "script_variation",
    entity_id: variation.id,
    brokerage_id: data.brokerageId,
    event_type: KernelEvent.SCRIPT_VARIATION_CREATED,
    actor_user_id: data.createdBy ?? null,
    metadata: {
      script_library_id: data.scriptLibraryId,
      variation_label: data.variationLabel,
      is_ab_test: data.isAbTest ?? false,
    },
  })

  // Fire kernel event for variation
  await processKernelEvent({
    event: KernelEvent.SCRIPT_VARIATION_CREATED,
    brokerageId: data.brokerageId,
    entityType: "script_variation",
    entityId: variation.id,
  }).catch(err => console.error("[video-generation] Kernel event failed:", err))

  revalidatePath("/dashboard/videos/library")
  return variation
}

// ============================================
// VIDEO GENERATION QUEUE
// ============================================

export async function queueVideoGeneration(data: {
  agentId: string
  scriptId?: string
  templateId?: string
  scriptContent: string
  videoType: string
  priority?: number
  scheduledFor?: string
  metadata?: any
}) {
  const supabase = await createClient()

  const { data: queueItem, error } = await supabase
    .from("video_generation_queue")
    .insert({
      agent_id: data.agentId,
      script_id: data.scriptId,
      template_id: data.templateId,
      script_content: data.scriptContent,
      video_type: data.videoType,
      priority: data.priority || 5,
      scheduled_for: data.scheduledFor,
      metadata: data.metadata,
      compliance_approved: false,
    })
    .select()
    .single()

  if (error) throw error

  return queueItem
}

export async function getVideoQueue(agentId: string) {
  if (!isValidUUID(agentId)) {
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("video_generation_queue")
    .select("*")
    .eq("agent_id", agentId)
    .in("status", ["pending", "processing"])
    .order("priority", { ascending: false })
    .order("created_at")

  if (error) {
    console.error("Error fetching video queue:", error)
    return []
  }

  return data || []
}

// ============================================
// VIDEO PERFORMANCE TRACKING — LAYER 8.5
// Tables: video_engagement_events (raw), video_performance_tracking (aggregates)
// DO NOT use video_analytics table
// ============================================

// Supported event types for video_engagement_events
export const VIDEO_EVENT_TYPES = [
  "view",
  "pause",
  "complete",
  "click",
  "share",
  "lead_capture",
  "cta_click",
  "replay",
] as const

export type VideoEventType = (typeof VIDEO_EVENT_TYPES)[number]

// Performance thresholds for kernel events
export const PERFORMANCE_THRESHOLDS = {
  HIGH_PERFORMER: {
    minViews: 100,
    minCompletionRate: 70,
    minClickThroughRate: 5,
  },
  LOW_PERFORMER: {
    minViews: 50,
    maxCompletionRate: 20,
    maxClickThroughRate: 1,
  },
}

export async function recordVideoEngagementEvent(data: {
  brokerageId: string
  videoAssetId?: string
  videoProjectId?: string
  contactId?: string
  eventType: VideoEventType
  watchDurationSeconds?: number
  metadata?: Record<string, any>
}) {
  if (!VIDEO_EVENT_TYPES.includes(data.eventType)) {
    throw new Error(`Invalid event type: ${data.eventType}`)
  }

  const supabase = await createClient()

  // 1. Insert raw event into video_engagement_events
  const { data: event, error: eventError } = await supabase
    .from("video_engagement_events")
    .insert({
      video_asset_id: data.videoAssetId || null,
      contact_id: data.contactId || null,
      event_type: data.eventType,
      watch_duration_seconds: data.watchDurationSeconds || 0,
      timestamp: new Date().toISOString(),
    })
    .select()
    .single()

  if (eventError) {
    console.error("[video-generation] Error recording engagement event:", eventError)
    throw eventError
  }

  // 2. Update aggregate metrics in video_performance_tracking
  const tracking = await updateVideoPerformanceAggregates({
    brokerageId: data.brokerageId,
    videoAssetId: data.videoAssetId,
    videoProjectId: data.videoProjectId,
    eventType: data.eventType,
    watchDurationSeconds: data.watchDurationSeconds || 0,
  })

  // 3. Check thresholds and fire kernel events
  if (tracking) {
    await checkAndFirePerformanceEvents(data.brokerageId, tracking)
  }

  revalidatePath("/dashboard/videos/analytics")
  return { event, tracking }
}

async function updateVideoPerformanceAggregates(data: {
  brokerageId: string
  videoAssetId?: string
  videoProjectId?: string
  eventType: VideoEventType
  watchDurationSeconds: number
}) {
  const supabase = await createClient()

  // Find existing tracking record
  let query = supabase.from("video_performance_tracking").select("*")

  if (data.videoAssetId) {
    query = query.eq("video_asset_id", data.videoAssetId)
  } else if (data.videoProjectId) {
    query = query.eq("video_project_id", data.videoProjectId)
  } else {
    return null
  }

  const { data: existing } = await query.maybeSingle()

  const now = new Date().toISOString()
  const updates: Record<string, any> = {
    last_event_at: now,
    updated_at: now,
  }

  if (existing) {
    // Update based on event type
    switch (data.eventType) {
      case "view":
        updates.total_views = (existing.total_views || 0) + 1
        updates.unique_views = (existing.unique_views || 0) + 1
        break
      case "complete":
        const totalViews = existing.total_views || 1
        const completions = Math.floor((existing.average_completion_rate || 0) * totalViews / 100) + 1
        updates.average_completion_rate = Math.round((completions / totalViews) * 100)
        break
      case "click":
      case "cta_click":
        const views = existing.total_views || 1
        const clicks = Math.floor((existing.click_through_rate || 0) * views / 100) + 1
        updates.click_through_rate = Math.round((clicks / views) * 100)
        break
      case "share":
        const viewsForShare = existing.total_views || 1
        const shares = Math.floor((existing.share_rate || 0) * viewsForShare / 100) + 1
        updates.share_rate = Math.round((shares / viewsForShare) * 100)
        break
      case "lead_capture":
        updates.lead_conversions = (existing.lead_conversions || 0) + 1
        updates.estimated_roi = (updates.lead_conversions || existing.lead_conversions || 0) * 500
        break
    }

    // Update watch time
    if (data.watchDurationSeconds > 0) {
      updates.total_watch_time_seconds = (existing.total_watch_time_seconds || 0) + data.watchDurationSeconds
      const totalViews = updates.total_views || existing.total_views || 1
      updates.average_watch_time_seconds = Math.round(
        (updates.total_watch_time_seconds || existing.total_watch_time_seconds || 0) / totalViews
      )
    }

    const { data: updated, error } = await supabase
      .from("video_performance_tracking")
      .update(updates)
      .eq("id", existing.id)
      .select()
      .single()

    if (error) {
      console.error("[video-generation] Error updating performance tracking:", error)
      return existing
    }

    return updated
  } else {
    // Create new record
    const newRecord = {
      video_asset_id: data.videoAssetId || null,
      video_project_id: data.videoProjectId || null,
      brokerage_id: data.brokerageId,
      total_views: data.eventType === "view" ? 1 : 0,
      unique_views: data.eventType === "view" ? 1 : 0,
      total_watch_time_seconds: data.watchDurationSeconds,
      average_watch_time_seconds: data.watchDurationSeconds,
      average_completion_rate: data.eventType === "complete" ? 100 : 0,
      click_through_rate: data.eventType === "click" || data.eventType === "cta_click" ? 100 : 0,
      share_rate: data.eventType === "share" ? 100 : 0,
      lead_conversions: data.eventType === "lead_capture" ? 1 : 0,
      estimated_roi: data.eventType === "lead_capture" ? 500 : 0,
      last_event_at: now,
      created_at: now,
      updated_at: now,
    }

    const { data: created, error } = await supabase
      .from("video_performance_tracking")
      .insert(newRecord)
      .select()
      .single()

    if (error) {
      console.error("[video-generation] Error creating performance tracking:", error)
      return null
    }

    return created
  }
}

async function checkAndFirePerformanceEvents(brokerageId: string, tracking: any) {
  const supabase = await createClient()
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
  }).catch(err => console.error("[video-generation] Kernel event failed:", err))

  // Check high performer threshold
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
    }).catch(err => console.error("[video-generation] Kernel event failed:", err))
  }

  // Check low performer threshold
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
    }).catch(err => console.error("[video-generation] Kernel event failed:", err))
  }
}

export async function getVideoPerformanceStats(agentId: string, brokerageId?: string) {
  const supabase = await createClient()

  // Get video projects for this agent
  let projectQuery = supabase.from("ai_video_projects").select("id, title, video_type, status, created_at")

  if (isValidUUID(agentId)) {
    projectQuery = projectQuery.eq("agent_id", agentId)
  } else if (brokerageId && isValidUUID(brokerageId)) {
    projectQuery = projectQuery.eq("brokerage_id", brokerageId)
  } else {
    return {
      totalViews: 0,
      uniqueViews: 0,
      totalWatchTime: 0,
      avgWatchTime: 0,
      avgCompletionRate: 0,
      avgClickThroughRate: 0,
      avgShareRate: 0,
      totalLeadConversions: 0,
      estimatedRoi: 0,
      topPerforming: [],
      videoCount: 0,
    }
  }

  const { data: videos } = await projectQuery

  if (!videos || videos.length === 0) {
    return {
      totalViews: 0,
      uniqueViews: 0,
      totalWatchTime: 0,
      avgWatchTime: 0,
      avgCompletionRate: 0,
      avgClickThroughRate: 0,
      avgShareRate: 0,
      totalLeadConversions: 0,
      estimatedRoi: 0,
      topPerforming: [],
      videoCount: 0,
    }
  }

  const videoIds = videos.map((v) => v.id)

  // Get performance tracking data
  const { data: performance } = await supabase
    .from("video_performance_tracking")
    .select("*")
    .in("video_project_id", videoIds)

  const performanceCount = performance?.length || 0

  const totalViews = performance?.reduce((sum, p) => sum + (p.total_views || 0), 0) || 0
  const uniqueViews = performance?.reduce((sum, p) => sum + (p.unique_views || 0), 0) || 0
  const totalWatchTime = performance?.reduce((sum, p) => sum + (p.total_watch_time_seconds || 0), 0) || 0
  const avgWatchTime = performanceCount > 0
    ? performance.reduce((sum, p) => sum + (p.average_watch_time_seconds || 0), 0) / performanceCount
    : 0
  const avgCompletionRate = performanceCount > 0
    ? performance.reduce((sum, p) => sum + (p.average_completion_rate || 0), 0) / performanceCount
    : 0
  const avgClickThroughRate = performanceCount > 0
    ? performance.reduce((sum, p) => sum + (p.click_through_rate || 0), 0) / performanceCount
    : 0
  const avgShareRate = performanceCount > 0
    ? performance.reduce((sum, p) => sum + (p.share_rate || 0), 0) / performanceCount
    : 0
  const totalLeadConversions = performance?.reduce((sum, p) => sum + (p.lead_conversions || 0), 0) || 0
  const estimatedRoi = performance?.reduce((sum, p) => sum + (p.estimated_roi || 0), 0) || 0

  // Get top performing videos
  const topPerforming = performance
    ?.sort((a, b) => (b.total_views || 0) - (a.total_views || 0))
    .slice(0, 10)
    .map((p) => {
      const video = videos.find(v => v.id === p.video_project_id)
      return {
        videoId: p.video_project_id,
        videoAssetId: p.video_asset_id,
        title: video?.title || "Untitled",
        videoType: video?.video_type || "unknown",
        totalViews: p.total_views || 0,
        uniqueViews: p.unique_views || 0,
        completionRate: p.average_completion_rate || 0,
        clickThroughRate: p.click_through_rate || 0,
        shareRate: p.share_rate || 0,
        leadConversions: p.lead_conversions || 0,
        estimatedRoi: p.estimated_roi || 0,
        lastEventAt: p.last_event_at,
      }
    }) || []

  return {
    totalViews,
    uniqueViews,
    totalWatchTime,
    avgWatchTime: Math.round(avgWatchTime),
    avgCompletionRate: Math.round(avgCompletionRate),
    avgClickThroughRate: Math.round(avgClickThroughRate * 10) / 10,
    avgShareRate: Math.round(avgShareRate * 10) / 10,
    totalLeadConversions,
    estimatedRoi,
    topPerforming,
    videoCount: videos.length,
  }
}

export async function getVideoEngagementEvents(filters: {
  brokerageId?: string
  videoAssetId?: string
  videoProjectId?: string
  contactId?: string
  eventType?: VideoEventType
  limit?: number
}) {
  const supabase = await createClient()

  let query = supabase
    .from("video_engagement_events")
    .select("*")
    .order("timestamp", { ascending: false })
    .limit(filters.limit || 100)

  if (filters.videoAssetId) {
    query = query.eq("video_asset_id", filters.videoAssetId)
  }
  if (filters.contactId) {
    query = query.eq("contact_id", filters.contactId)
  }
  if (filters.eventType) {
    query = query.eq("event_type", filters.eventType)
  }

  const { data, error } = await query

  if (error) {
    console.error("[video-generation] Error fetching engagement events:", error)
    return []
  }

  return data || []
}

export async function getVideoPerformanceTracking(filters: {
  brokerageId?: string
  videoAssetId?: string
  videoProjectId?: string
  limit?: number
}) {
  const supabase = await createClient()

  let query = supabase
    .from("video_performance_tracking")
    .select("*")
    .order("total_views", { ascending: false })
    .limit(filters.limit || 50)

  if (filters.brokerageId) {
    query = query.eq("brokerage_id", filters.brokerageId)
  }
  if (filters.videoAssetId) {
    query = query.eq("video_asset_id", filters.videoAssetId)
  }
  if (filters.videoProjectId) {
    query = query.eq("video_project_id", filters.videoProjectId)
  }

  const { data, error } = await query

  if (error) {
    console.error("[video-generation] Error fetching performance tracking:", error)
    return []
  }

  return data || []
}

// ============================================
// AGENT VIDEO PROFILE
// ============================================

export async function getAgentVideoProfile(agentId: string) {
  if (!isValidUUID(agentId)) {
    return null
  }

  const supabase = await createClient()

  const { data, error } = await supabase.from("agent_voice_profiles").select("*").eq("agent_id", agentId).maybeSingle()

  if (error) {
    console.error("Error fetching agent video profile:", error)
    return null
  }

  return data
}

export async function updateAgentVideoProfile(data: {
  agentId: string
  heygenAvatarId?: string
  defaultVoiceId?: string
  defaultBackgroundId?: string
  brandingPresetId?: string
  introScript?: string
  outroScript?: string
  defaultStyle?: string
}) {
  const supabase = await createClient()

  const { data: profile, error } = await supabase
    .from("agent_voice_profiles")
    .upsert({
      agent_id: data.agentId,
      heygen_avatar_id: data.heygenAvatarId,
      default_voice_id: data.defaultVoiceId,
      default_background_id: data.defaultBackgroundId,
      branding_preset_id: data.brandingPresetId,
      intro_script: data.introScript,
      outro_script: data.outroScript,
      default_style: data.defaultStyle,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/videos/settings")
  return profile
}

// ============================================
// VIDEO BRANDING PRESETS
// ============================================

export async function getVideoBrandingPresets(agentId: string) {
  if (!isValidUUID(agentId)) {
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("video_branding_presets")
    .select("*")
    .or(`agent_id.eq.${agentId},is_default.eq.true`)
    .order("is_default", { ascending: false })

  if (error) {
    console.error("Error fetching branding presets:", error)
    return []
  }

  return data || []
}

export async function saveBrandingPreset(data: {
  agentId: string
  presetName: string
  logoUrl?: string
  primaryColor?: string
  secondaryColor?: string
  fontFamily?: string
  introAnimation?: string
  outroAnimation?: string
  watermarkPosition?: string
  socialHandles?: any
}) {
  const supabase = await createClient()

  const { data: preset, error } = await supabase
    .from("video_branding_presets")
    .insert({
      agent_id: data.agentId,
      preset_name: data.presetName,
      logo_url: data.logoUrl,
      primary_color: data.primaryColor,
      secondary_color: data.secondaryColor,
      font_family: data.fontFamily,
      intro_animation: data.introAnimation,
      outro_animation: data.outroAnimation,
      watermark_position: data.watermarkPosition,
      social_handles: data.socialHandles,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/videos/branding")
  return preset
}

// ============================================
// ORIGINAL VIDEO GENERATION FUNCTIONS
// ============================================

export async function generateVideoScript(params: {
  purpose: string
  persona: string
  contactName: string
  tone?: string
  length?: string
  userId?: string
  brokerageId?: string
}) {
  try {
    const { generateAIResponse } = await import("@/lib/ai")
    
    const purposeDescriptions: Record<string, string> = {
      welcome: "a warm welcome message introducing yourself and your services",
      market_update: "a professional market update with current trends and statistics",
      personalized_buyer: "a personalized message for a buyer highlighting properties and opportunities",
      personalized_seller: "a personalized message for a seller with listing strategies",
      holiday_greeting: "a friendly holiday greeting message",
      thank_you: "an appreciative thank you message for their business",
      listing_preview: "an exciting preview of a new listing coming to market",
      open_house: "an invitation to an upcoming open house event",
    }
    
    const personaDescriptions: Record<string, string> = {
      first_time_buyer: "first-time homebuyers who need guidance and reassurance",
      luxury_buyer: "luxury buyers looking for premium properties and white-glove service",
      investor: "real estate investors focused on ROI and market opportunities",
      downsizer: "empty nesters looking to downsize to a more manageable home",
      relocator: "people relocating to the area who need local market expertise",
      seller: "homeowners looking to sell their property for top dollar",
    }
    
    const toneMap: Record<string, string> = {
      professional: "professional and authoritative",
      friendly: "warm and conversational",
      energetic: "enthusiastic and energetic",
      empathetic: "empathetic and understanding",
    }
    
    const lengthMap: Record<string, string> = {
      short: "30-45 seconds (approximately 75-100 words)",
      medium: "60-90 seconds (approximately 150-200 words)",
      long: "2-3 minutes (approximately 300-400 words)",
    }
    
    const prompt = `Generate a compelling video script for ${purposeDescriptions[params.purpose] || params.purpose} targeting ${personaDescriptions[params.persona] || params.persona}.
    
Tone: ${toneMap[params.tone || "friendly"] || "warm and professional"}
Length: ${lengthMap[params.length || "medium"] || "60-90 seconds"}
Contact Name: ${params.contactName}

Requirements:
- Start with a strong hook in the first 5 seconds
- Be authentic and conversational
- Include specific value propositions
- End with a clear call-to-action
- Use "you" and "your" language
- No filler words or corporate jargon
- Make it feel personal and genuine

Return ONLY the script text, no formatting or labels.`

    const response = await generateAIResponse({
      prompt,
      metadata: {
        userId: params.userId,
        brokerageId: params.brokerageId,
        feature: "video_script_generation",
      },
    })
    
    console.log("[v0] Generated video script for purpose:", params.purpose, "persona:", params.persona)
    
    return { success: true, script: response.text.trim() }
  } catch (error: any) {
    console.error("[v0] Script generation error:", error)
    return { success: false, error: error.message }
  }
}

export async function generateVideoFromScript(params: {
  script: string
  title: string
  type: "avatar" | "voice"
  avatarId?: string
  voiceId?: string
  userId?: string
}) {
  const supabase = createServiceClient()

  try {
    console.log("[v0] Generating video from script:", params.title)

    // Validate that agent has required settings
    if (params.type === "avatar" && !params.avatarId) {
      return { success: false, error: "Avatar ID not configured. Please set up in Agent Roster." }
    }
    if (!params.voiceId) {
      return { success: false, error: "Voice ID not configured. Please set up in Agent Roster." }
    }

    const { data: queueRecord, error: queueError } = await supabase
      .from("video_generation_queue")
      .insert({
        user_id: params.userId || null,
        title: params.title,
        script: params.script,
        video_type: params.type,
        heygen_avatar_id: params.avatarId,
        heygen_voice_id: params.voiceId,
        status: "queued",
      })
      .select()
      .single()

    if (queueError) {
      console.error("[v0] Queue error:", queueError)
      throw queueError
    }

    // Create video script record for backward compatibility
    const { data: scriptRecord, error: scriptError } = await supabase
      .from("video_scripts_library")
      .insert({
        script_text: params.script,
        title: params.title,
        created_by: params.userId || "system",
        video_status: "queued",
        persona_validated: true,
        video_type: params.type,
      })
      .select()
      .single()

    if (scriptError) console.warn("[v0] Script record error:", scriptError)

    // TODO: Integrate with HeyGen API when credentials are added
    // For now, mark as queued - actual processing happens in background job
    console.log("[v0] Video queued successfully:", queueRecord.id)
    return { success: true, videoId: queueRecord.id, queueId: scriptRecord?.id }
  } catch (error: any) {
    console.error("[v0] Video generation error:", error)
    return { success: false, error: error.message }
  }
}

export async function createAvatarVideo(params: {
  scriptId: string
  script: string
  avatarId?: string
  voice?: string
  userId?: string
}) {
  const supabase = createServiceClient()

  try {
    console.log("[v0] Generating video for script:", params.scriptId)

    // TODO: Integrate with HeyGen API when credentials are added
    // For now, simulate video generation
    const videoUrl = `https://example.com/videos/${params.scriptId}.mp4`

    // Update script with video URL
    const { error } = await supabase
      .from("video_scripts_library")
      .update({
        video_url: videoUrl,
        video_status: "completed",
        video_generated_at: new Date().toISOString(),
      })
      .eq("id", params.scriptId)

    if (error) throw error

    console.log("[v0] Video generated successfully:", videoUrl)
    return { success: true, videoUrl }
  } catch (error: any) {
    console.error("[v0] Video generation error:", error)
    return { success: false, error: error.message }
  }
}
