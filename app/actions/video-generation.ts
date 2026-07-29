"use server"

import { toLibraryScriptType } from "@/app/types/video-generation"
import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { resolveProvider } from "@/lib/kernel/providers"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"
import type { ScriptType, ApprovalStatus, VideoScript, ScriptVariation, VideoEventType } from "@/app/types/video-generation"
import { VIDEO_EVENT_TYPES, PERFORMANCE_THRESHOLDS } from "@/app/types/video-generation"

// ─── Auth helper ──────────────────────────────────────────────────────────────
//
// Every function in this file previously trusted caller-supplied brokerageId
// / agentId / userId without authentication. Any signed-in (or even
// unauthenticated, for some reads) user could:
//   - List/read any brokerage's video scripts, templates, performance data
//   - Burn paid HeyGen + Claude inference under our API keys
//   - Insert scripts/variations/queue items under arbitrary brokerages/agents
//   - Forge engagement events against another brokerage's videos
// This helper resolves identity from the session; callers ignore the
// caller-supplied IDs and use session-derived values.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

// Resolve caller's agents.id (some video tables use agent_id which is
// agents.id, not auth.users.id). Returns null if caller isn't a registered
// agent (e.g. brokerage admin) — callers handle that case.
async function resolveAgentIdForCaller(userId: string, brokerageId: string): Promise<string | null> {
  const svc = createServiceClient()
  const { data } = await svc
    .from("agents")
    .select("id")
    .eq("user_id", userId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  return data?.id ?? null
}

// ============================================
// VIDEO SCRIPT LIBRARY — CANONICAL TABLE
// Table: public.video_scripts_library
// ============================================

export async function getVideoScriptLibrary(filters?: {
  brokerageId?: string  // ignored — derived from session
  agentId?: string
  scriptType?: ScriptType
  templateBacked?: boolean
  approvalStatus?: ApprovalStatus
  includeVariationCount?: boolean
}) {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  let query = supabase
    .from("video_scripts_library")
    .select(`
      *,
      video_templates(id, template_name, category),
      script_variations(id)
    `)
    .eq("is_active", true)
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })

  if (filters?.agentId && isValidUUID(filters.agentId)) {
    // agent_id here is agents.id — caller-supplied filter, but already
    // pre-scoped by brokerage so they can only narrow within their own.
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

  const auth = await requireCaller()
  if (!auth.ok) return null

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("video_scripts_library")
    .select(`
      *,
      video_templates(id, template_name, category, default_script, duration_seconds),
      script_variations(*)
    `)
    .eq("id", scriptId)
    .eq("brokerage_id", auth.brokerageId)
    .single()

  if (error) {
    console.error("[video-generation] Error fetching script:", error)
    return null
  }

  return data
}

export async function saveVideoScript(data: {
  brokerageId?: string  // ignored — derived from session
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
  createdBy?: string  // ignored — derived from session
}) {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)
  const brokerageId = auth.brokerageId
  const createdBy = auth.userId

  const supabase = createServiceClient()

  // If caller supplied agent_id, verify it belongs to their brokerage
  if (data.agentId && isValidUUID(data.agentId)) {
    const { data: agentRow } = await supabase
      .from("agents").select("brokerage_id").eq("id", data.agentId).maybeSingle()
    if (!agentRow || agentRow.brokerage_id !== brokerageId) {
      throw new Error("Forbidden: agent not in your brokerage")
    }
  }
  // Same for listing
  if (data.listingId && isValidUUID(data.listingId)) {
    const { data: lstRow } = await supabase
      .from("listings").select("brokerage_id").eq("id", data.listingId).maybeSingle()
    if (!lstRow || lstRow.brokerage_id !== brokerageId) {
      throw new Error("Forbidden: listing not in your brokerage")
    }
  }
  if (data.contactId && isValidUUID(data.contactId)) {
    const { data: ctRow } = await supabase
      .from("contacts").select("brokerage_id").eq("id", data.contactId).maybeSingle()
    if (!ctRow || ctRow.brokerage_id !== brokerageId) {
      throw new Error("Forbidden: contact not in your brokerage")
    }
  }

  const { data: script, error } = await supabase
    .from("video_scripts_library")
    .insert({
      brokerage_id: brokerageId,
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
      created_by: createdBy,
      // NOTE: schema drift — compliance_approved column does not exist on
      // live video_scripts_library; insert silently drops unknown columns.
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
    brokerage_id: brokerageId,
    event_type: KernelEvent.SCRIPT_GENERATED,
    actor_user_id: createdBy,
    metadata: {
      script_type: data.scriptType,
      ai_generated: data.aiGenerated ?? false,
      approval_status: data.approvalStatus ?? "draft",
    },
  })

  // Fire kernel event
  await processKernelEvent({
    event: KernelEvent.SCRIPT_GENERATED,
    brokerageId: brokerageId,
    entityType: "video_script",
    entityId: script.id,
  }).catch(err => console.error("[video-generation] Kernel event failed:", err))

  revalidatePath("/dashboard/videos")
  revalidatePath("/dashboard/videos/library")
  return script
}

export async function updateScriptApprovalStatus(
  scriptId: string,
  _brokerageId: string,  // ignored — derived from session
  approvalStatus: ApprovalStatus,
  complianceReviewNotes?: string,
  _actorUserId?: string  // ignored — derived from session
) {
  if (!isValidUUID(scriptId)) throw new Error("Invalid script ID")

  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)
  const brokerageId = auth.brokerageId
  const actorUserId = auth.userId

  const supabase = createServiceClient()

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
    actor_user_id: actorUserId,
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
  // Auth gate — video_templates is a global library (no brokerage_id in live
  // schema). Still require a session to prevent unauthenticated discovery.
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

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

  const auth = await requireCaller()
  if (!auth.ok) return null

  const supabase = createServiceClient()

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

  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  // Verify the parent script belongs to caller's brokerage before reading variations
  const { data: parent } = await supabase
    .from("video_scripts_library")
    .select("brokerage_id")
    .eq("id", scriptLibraryId)
    .maybeSingle()
  if (!parent || parent.brokerage_id !== auth.brokerageId) return []

  const { data, error } = await supabase
    .from("script_variations")
    .select("*")
    .eq("script_library_id", scriptLibraryId)
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[video-generation] Error fetching variations:", error)
    return []
  }

  return data || []
}

export async function createScriptVariation(data: {
  scriptLibraryId: string
  brokerageId?: string  // ignored — derived from session
  variationLabel: string
  variationGoal?: string
  scriptContent: string
  callToAction?: string
  audienceSegment?: string
  isAbTest?: boolean
  createdBy?: string  // ignored — derived from session
}) {
  if (!isValidUUID(data.scriptLibraryId)) {
    throw new Error("Invalid script library ID")
  }

  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)
  const brokerageId = auth.brokerageId
  const createdBy = auth.userId

  const supabase = createServiceClient()

  // Verify the parent script belongs to caller's brokerage
  const { data: parent } = await supabase
    .from("video_scripts_library")
    .select("brokerage_id")
    .eq("id", data.scriptLibraryId)
    .maybeSingle()
  if (!parent) throw new Error("Script not found")
  if (parent.brokerage_id !== brokerageId) throw new Error("Forbidden")

  const { data: variation, error } = await supabase
    .from("script_variations")
    .insert({
      script_library_id: data.scriptLibraryId,
      brokerage_id: brokerageId,
      variation_label: data.variationLabel,
      variation_goal: data.variationGoal ?? null,
      script_content: data.scriptContent,
      call_to_action: data.callToAction ?? null,
      audience_segment: data.audienceSegment ?? null,
      is_ab_test: data.isAbTest ?? false,
      created_by: createdBy,
      // NOTE: schema drift — compliance_approved column does not exist on
      // live script_variations; insert silently drops unknown columns.
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
    brokerage_id: brokerageId,
    event_type: KernelEvent.SCRIPT_VARIATION_CREATED,
    actor_user_id: createdBy,
    metadata: {
      script_library_id: data.scriptLibraryId,
      variation_label: data.variationLabel,
      is_ab_test: data.isAbTest ?? false,
    },
  })

  // Fire kernel event for variation
  await processKernelEvent({
    event: KernelEvent.SCRIPT_VARIATION_CREATED,
    brokerageId: brokerageId,
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
  agentId?: string  // ignored — derived from session
  scriptId?: string
  templateId?: string
  scriptContent: string
  videoType: string
  priority?: number
  scheduledFor?: string
  metadata?: any
}) {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)

  // SCHEMA DRIFT: live video_generation_queue has only id, project_id,
  // status, priority, created_at, processed_at — none of agent_id,
  // script_id, template_id, script_content, video_type, scheduled_for,
  // metadata, compliance_approved exist. The richer queue model lives in
  // ai_video_projects. We refuse to insert the drift columns to surface
  // the bug; callers should be migrated to insert into ai_video_projects
  // directly.
  return {
    error: "queueVideoGeneration: schema drift — use ai_video_projects insertion path instead",
  }
}

export async function getVideoQueue(_agentId: string) {
  // SCHEMA DRIFT: video_generation_queue has no agent_id column in live
  // schema. Auth gate added to prevent unauthenticated probing while we
  // resolve the drift. Returns empty until the queue model is reconciled.
  const auth = await requireCaller()
  if (!auth.ok) return []
  return []
}

// ============================================
// VIDEO PERFORMANCE TRACKING — LAYER 8.5
// Tables: video_engagement_events (raw), video_performance_tracking (aggregates)
// DO NOT use video_analytics table
// ============================================

// VIDEO_EVENT_TYPES, VideoEventType, and PERFORMANCE_THRESHOLDS are imported from @/app/types/video-generation

export async function recordVideoEngagementEvent(data: {
  brokerageId?: string  // ignored — derived from session or target row
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

  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)

  const supabase = createServiceClient()

  // Resolve the actual brokerage_id from the target video row to prevent a
  // hostile caller from logging events against another tenant's videos.
  let resolvedBrokerageId: string | null = null
  if (data.videoProjectId && isValidUUID(data.videoProjectId)) {
    const { data: proj } = await supabase
      .from("ai_video_projects").select("brokerage_id").eq("id", data.videoProjectId).maybeSingle()
    resolvedBrokerageId = proj?.brokerage_id ?? null
  } else if (data.videoAssetId && isValidUUID(data.videoAssetId)) {
    const { data: tracking } = await supabase
      .from("video_performance_tracking").select("brokerage_id").eq("video_asset_id", data.videoAssetId).maybeSingle()
    resolvedBrokerageId = tracking?.brokerage_id ?? null
  }
  // Fall back to session brokerage if no video row exists yet (first event).
  if (!resolvedBrokerageId) resolvedBrokerageId = auth.brokerageId
  if (resolvedBrokerageId !== auth.brokerageId) {
    throw new Error("Forbidden")
  }
  const brokerageId = resolvedBrokerageId

  // 1. Insert raw event into video_engagement_events
  const { data: event, error: eventError } = await supabase
    .from("video_engagement_events")
    .insert({
      brokerage_id: brokerageId,
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
    brokerageId: brokerageId,
    videoAssetId: data.videoAssetId,
    videoProjectId: data.videoProjectId,
    eventType: data.eventType,
    watchDurationSeconds: data.watchDurationSeconds || 0,
  })

  // 3. Check thresholds and fire kernel events
  if (tracking) {
    await checkAndFirePerformanceEvents(brokerageId, tracking)
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
  // Internal helper — invoked only after recordVideoEngagementEvent's
  // auth gate has already resolved + verified brokerageId.
  const supabase = createServiceClient()

  // Find existing tracking record — scoped by brokerage so we never
  // accidentally update another tenant's row even if asset_id collides.
  let query = supabase.from("video_performance_tracking").select("*")
    .eq("brokerage_id", data.brokerageId)

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
  // Internal helper — invoked only after recordVideoEngagementEvent's
  // auth gate has resolved brokerageId.
  const supabase = createServiceClient()
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

export async function getVideoPerformanceStats(agentId: string, _brokerageId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) {
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

  const supabase = createServiceClient()

  // Always scope to caller's brokerage; agentId filter is optional and
  // pre-scoped (caller can only narrow within their own brokerage).
  let projectQuery = supabase.from("ai_video_projects")
    .select("id, title, video_type, status, created_at")
    .eq("brokerage_id", auth.brokerageId)

  if (isValidUUID(agentId)) {
    projectQuery = projectQuery.eq("agent_id", agentId)
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

  // Get performance tracking data — scope by brokerage so a hostile
  // collision on video_project_id can't leak another tenant's metrics.
  const { data: performance } = await supabase
    .from("video_performance_tracking")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .in("video_project_id", videoIds)

  const performanceCount = performance?.length || 0

  const totalViews = performance?.reduce((sum, p) => sum + (p.total_views || 0), 0) || 0
  const uniqueViews = performance?.reduce((sum, p) => sum + (p.unique_views || 0), 0) || 0
  const totalWatchTime = performance?.reduce((sum, p) => sum + (p.total_watch_time_seconds || 0), 0) || 0
  const avgWatchTime = performanceCount > 0
    ? (performance ?? []).reduce((sum, p) => sum + (p.average_watch_time_seconds || 0), 0) / performanceCount
    : 0
  const avgCompletionRate = performanceCount > 0
    ? (performance ?? []).reduce((sum, p) => sum + (p.average_completion_rate || 0), 0) / performanceCount
    : 0
  const avgClickThroughRate = performanceCount > 0
    ? (performance ?? []).reduce((sum, p) => sum + (p.click_through_rate || 0), 0) / performanceCount
    : 0
  const avgShareRate = performanceCount > 0
    ? (performance ?? []).reduce((sum, p) => sum + (p.share_rate || 0), 0) / performanceCount
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
  brokerageId?: string  // ignored — derived from session
  videoAssetId?: string
  videoProjectId?: string
  contactId?: string
  eventType?: VideoEventType
  limit?: number
}) {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  let query = supabase
    .from("video_engagement_events")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
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
  brokerageId?: string  // ignored — derived from session
  videoAssetId?: string
  videoProjectId?: string
  limit?: number
}) {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  let query = supabase
    .from("video_performance_tracking")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .order("total_views", { ascending: false })
    .limit(filters.limit || 50)

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

  const auth = await requireCaller()
  if (!auth.ok) return null

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("agent_voice_profiles")
    .select("*")
    .eq("agent_id", agentId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()

  if (error) {
    console.error("Error fetching agent video profile:", error)
    return null
  }

  return data
}

// updateAgentVideoProfile was DELETED (l38 heygen purge): zero callers, a
// heygen-named param, and it duplicated the Twin Studio — the ONE place
// agents create their D-ID avatar (photo or video upload) and ElevenLabs
// voice clone (app/dashboard/settings/twin-studio).

// ============================================
// VIDEO BRANDING — keep-one (HeyGen-era presets removed)
// ============================================
// The video_branding_presets table (HeyGen-era: heygen_avatar_id /
// heygen_template_id columns) was DROPPED live in l38-s01 — it had zero
// UI callers and duplicated the canonical brand sources. Video branding
// comes from ONE place: brokerages.primary_color/logo_url +
// brokerage_brand_settings.accent_color via resolveReelBrand
// (lib/video/reel-brand.ts) — the same brand every reel producer uses.

// ============================================
// ORIGINAL VIDEO GENERATION FUNCTIONS
// ============================================

/**
 * PERSONALIZED CONTACT-MESSAGE scripts — welcome / thank-you / holiday /
 * personalized buyer + seller / open-house invite, addressed to a named contact.
 *
 * NOT the same function as app/actions/video/generate-script.ts despite the shared
 * name. That one writes MARKETING videos from a video type (property_tour,
 * agent_intro, listing_presentation …) against the shared script-structure
 * vocabulary, with word-count targeting and the evaluateOutbound compliance gate.
 * This one writes a one-to-one message from a purpose + persona. Two products, one
 * unfortunate name — nine functions in this repo are called generateVideoScript and
 * most are genuinely distinct (library authoring, URL repurposing, project-based,
 * the generic content pipeline, and a private hardcoded template).
 *
 * The second parameter shape that used to live here — agentId, brokerageId,
 * targetDurationSeconds, listingContext, saveToLibrary — was labelled "used by
 * /dashboard/videos/create". That page imports the OTHER generateVideoScript, and
 * none of those five params was ever read in this body. It was dead surface area
 * that made two distinct functions look like duplicates of each other. Removed.
 * videoType and description stay: both are read below as fallbacks.
 */
export async function generateVideoScript(params: {
  purpose?: string
  persona?: string
  contactName?: string
  tone?: string
  length?: string
  userId?: string  // ignored — derived from session
  /** Fallback when no `purpose` is given. */
  videoType?: string
  /** Free-text fallback when the purpose key is unrecognised. */
  description?: string
}) {
  // Auth gate — this function burns paid Claude inference under our API
  // key. Previously open: any caller could trigger script generation.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

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
    
    const purposeKey = params.purpose ?? params.videoType ?? "welcome"
    const personaKey = params.persona ?? "first_time_buyer"
    const prompt = `Generate a compelling video script for ${purposeDescriptions[purposeKey] || params.description || purposeKey} targeting ${personaDescriptions[personaKey] || personaKey}.
    
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
        userId: auth.userId,
        brokerageId: auth.brokerageId,
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
  userId?: string  // ignored — derived from session
}) {
  // Auth gate — calls HeyGen API which burns paid credits under our key.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

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

    // SCHEMA DRIFT: live video_generation_queue has only id, project_id,
    // status, priority, created_at, processed_at. The columns inserted
    // below (user_id, title, script, video_type, heygen_avatar_id,
    // heygen_voice_id) do not exist on that table — Supabase will silently
    // drop them, leaving a row with status only. Callers should migrate
    // to ai_video_projects, which has the full video metadata schema.
    const { data: queueRecord, error: queueError } = await supabase
      .from("video_generation_queue")
      .insert({
        status: "queued",
        priority: 5,
      })
      .select()
      .single()

    if (queueError) {
      console.error("[v0] Queue error:", queueError)
      throw queueError
    }

    // Create video script record for backward compatibility
    // SCHEMA DRIFT: video_scripts_library has no script_text / video_status
    // / persona_validated / video_type columns — only script_content / etc.
    // Map to the real columns we have.
    const { data: scriptRecord, error: scriptError } = await supabase
      .from("video_scripts_library")
      .insert({
        brokerage_id: auth.brokerageId,
        script_content: params.script,
        title: params.title,
        created_by: auth.userId,
        // "video" violated the script_type CHECK — every script record from this
        // path silently never persisted (error only console.warned).
        script_type: toLibraryScriptType("custom"),
        is_active: true,
      })
      .select()
      .single()

    if (scriptError) console.warn("[v0] Script record error:", scriptError)

    // Kick off generation via the platform engine — D-ID + ElevenLabs (no HeyGen).
    // Non-fatal: if the provider isn't configured the item stays queued for the
    // render pipeline. (Was a direct api.heygen.com call — business-rule violation.)
    if (params.avatarId && params.voiceId) {
      const { generateAvatarVideo } = await import("@/app/actions/external-services")
      const didRes = await generateAvatarVideo({
        avatarId: params.avatarId,
        voiceId: params.voiceId,
        script: params.script,
        brokerageId: auth.brokerageId ?? undefined,
      })
      if (didRes.success && (didRes as { videoId?: string }).videoId) {
        // The D-ID provider job id has no column on video_generation_queue; its canonical
        // home is ai_video_projects.provider_job_id (see create-video-project + poll-did-videos).
        // This legacy path creates no project row, so only advance status + log the job id.
        await supabase.from("video_generation_queue")
          .update({ status: "generating" })
          .eq("id", queueRecord.id)
        console.log(`[v0] D-ID video_id=${(didRes as { videoId?: string }).videoId} queue=${queueRecord.id}`)
      } else {
        console.warn("[v0] D-ID kick deferred, video stays queued:", (didRes as { error?: string }).error)
      }
    }

    console.log("[v0] Video queued successfully:", queueRecord.id)
    return { success: true, videoId: queueRecord.id, queueId: scriptRecord?.id }
  } catch (error: any) {
    console.error("[v0] Video generation error:", error)
    return { success: false, error: error.message }
  }
}

// ============================================
// VIDEO TEMPLATES — SAVE / CRUD
// ============================================

export async function saveVideoTemplate(data: {
  brokerageId?: string  // ignored — derived from session (and not stored, see below)
  agentId?: string
  teamId?: string
  templateName: string
  category: string
  scriptType?: string
  defaultScript?: string
  durationSeconds?: number
  tags?: string[]
  createdBy?: string  // ignored — derived from session
}) {
  // Auth gate. SCHEMA DRIFT: live video_templates has only id,
  // template_name, category, description, thumbnail_url, default_script,
  // duration_seconds, recommended_for, tags, sort_order, is_active,
  // created_at, updated_at — no brokerage_id, agent_id, team_id,
  // script_type, or created_by. Inserts of those drift columns are
  // silently dropped, so templates are GLOBAL not brokerage-scoped. To
  // prevent cross-tenant template pollution, we restrict this action to
  // brokerage admins only.
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)

  const supabase = createServiceClient()

  const { data: callerUser } = await supabase
    .from("users").select("user_type").eq("id", auth.userId).maybeSingle()
  const isAdmin = ["admin", "broker", "broker_owner", "superadmin", "super_admin"]
    .includes(callerUser?.user_type ?? "")
  if (!isAdmin) {
    throw new Error("Forbidden: only brokerage admins can save video templates (global library)")
  }

  const { data: result, error } = await supabase
    .from("video_templates")
    .insert({
      template_name: data.templateName,
      category: data.category,
      default_script: data.defaultScript ?? null,
      duration_seconds: data.durationSeconds ?? null,
      tags: data.tags ?? [],
      is_active: true,
    })
    .select()
    .single()

  if (error) {
    console.error("[video-generation] Error saving template:", error)
    throw new Error(error.message)
  }

  revalidatePath("/dashboard/videos/templates")
  return result
}

export async function getEducationTemplates() {
  return getVideoTemplates({ category: "education" })
}

export async function createAvatarVideo(params: {
  scriptId: string
  script: string
  avatarId?: string
  voice?: string
  userId?: string  // ignored — derived from session
}) {
  if (!isValidUUID(params.scriptId)) {
    return { success: false, error: "Invalid script ID" }
  }

  // Auth gate — calls HeyGen API which burns paid credits under our key.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  // Verify script belongs to caller's brokerage before billing HeyGen
  const { data: scriptRow } = await supabase
    .from("video_scripts_library")
    .select("brokerage_id")
    .eq("id", params.scriptId)
    .maybeSingle()
  if (!scriptRow) return { success: false, error: "Script not found" }
  if (scriptRow.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  try {
    console.log("[v0] Generating avatar video for script:", params.scriptId)

    // Platform engine: D-ID + ElevenLabs (no HeyGen). Delegate to the rewired
    // generation action (was a direct api.heygen.com call — business-rule violation).
    const { generateAvatarVideo } = await import("@/app/actions/external-services")
    const didRes = await generateAvatarVideo({
      avatarId: params.avatarId || "",
      voiceId: params.voice || "",
      script: params.script,
      brokerageId: auth.brokerageId ?? undefined,
    })
    if (!didRes.success) {
      return { success: false, error: (didRes as { error?: string }).error || "Video provider error (D-ID + ElevenLabs)" }
    }
    const didVideoId = (didRes as { videoId?: string }).videoId
    // Provider job tracking belongs on ai_video_projects (provider_job_id/_status);
    // video_scripts_library has no place to persist it — log so it isn't lost.
    console.log(`[video-generation] D-ID video_id=${didVideoId} for script ${params.scriptId}`)

    return { success: true, videoId: didVideoId, status: "generating" }
  } catch (error: any) {
    console.error("[v0] Video generation error:", error)
    return { success: false, error: error.message }
  }
}
