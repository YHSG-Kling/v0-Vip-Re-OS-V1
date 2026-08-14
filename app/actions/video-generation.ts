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
import {
  buildComplianceSystemBlocks,
  precheckBriefForFairHousing,
  postcheckScript,
} from "@/lib/video/script-compliance"
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

// `queueVideoGeneration` REMOVED (Wave 6). It was a stub whose entire body was
// `return { error: "schema drift — use ai_video_projects insertion path instead" }`
// — a public HTTP endpoint that could never queue anything, with no callers.
// Survivors, which are the "ai_video_projects insertion path" its own error names:
//   • app/actions/video.ts:submitVideoGenerationJobAction — tenant-gated via
//     assertProjectInCallerBrokerage, delegating to
//     lib/kernel/video.ts:submitVideoGenerationJob (atomic project-slot claim).
//   • app/actions/video-generation.ts:generateVideoFromScript — script → project →
//     queue row → provider job, for the "I have a script" entry point.
// Nothing was ported: a stub that returns an error string has no capability to move.

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

  // THE OWNER'S VIRAL RULE — "if the video goes viral using that script, it
  // should be shared to the whole brokerage." This is the lane where video
  // engagement is actually processed, so the promotion rides it rather than
  // getting a path of its own. Safe on every event: below VIRAL_VIEW_THRESHOLD,
  // and on every event after the first crossing, it is a no-op (the promotion is
  // a conditional single-column UPDATE the database decides).
  //
  // It is passed ONLY the project id — it re-reads the view count and BOTH
  // tenants itself, so nothing in this call can misdirect it. Non-fatal: a
  // failed promotion must not lose the engagement event that was already
  // recorded, so it is logged rather than thrown.
  if (tracking.video_project_id) {
    const { shareViralScriptWithBrokerage } = await import("@/lib/video/viral-script-share")
    await shareViralScriptWithBrokerage(tracking.video_project_id).catch(err =>
      console.error("[video-generation] viral script share failed:", err),
    )
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

  // Compliance gate — same one the /dashboard/videos/create wizard enforces.
  // This path feeds /video-assistant and the agent superpowers panel, and it
  // used to generate agent-facing marketing copy with no Fair Housing check
  // and no brand voice at all.
  const actor = { userId: auth.userId, brokerageId: auth.brokerageId }
  // personalized_seller / listing_preview address the seller side; everything
  // else in purposeDescriptions speaks to a buyer.
  const journeyType: "buyer" | "seller" =
    params.purpose === "personalized_seller" || params.purpose === "listing_preview"
      ? "seller"
      : "buyer"

  // The agent's free-text description is the only caller-authored prose here —
  // the purpose/persona/tone keys are ours. Gate it when present.
  if (params.description?.trim()) {
    const preCheck = await precheckBriefForFairHousing(actor, params.description, journeyType)
    if (preCheck.blocked) {
      return {
        success: false,
        complianceBlocked: true,
        error: `Description contains a Fair Housing violation: ${preCheck.reason}`,
      }
    }
  }

  try {
    const { generateAIResponse } = await import("@/lib/ai")
    const complianceBlocks = await buildComplianceSystemBlocks(auth.brokerageId)

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
      // Brand voice + ThemFirst + Fair Housing, injected proactively so the
      // model complies before the advisory post-check ever runs.
      system: complianceBlocks.join("\n\n"),
      metadata: {
        userId: auth.userId,
        brokerageId: auth.brokerageId,
        feature: "video_script_generation",
      },
    })

    const script = response.text.trim()

    // Advisory — the agent sees what slipped through, next to a Regenerate button.
    const complianceWarnings = await postcheckScript(actor, script, journeyType)

    return { success: true, script, complianceWarnings }
  } catch (error: any) {
    console.error("[video-generation] Script generation error:", error)
    return { success: false, error: error.message }
  }
}

/**
 * Render a video from a script.
 *
 * WAVE 6 — absorbed the only capability its twin `createAvatarVideo` had that
 * this lacked: **rendering from a script already saved in the library**, named by
 * `scriptId`. Supply `scriptId` and the script text and title are read from
 * `video_scripts_library` (tenant-checked), and no duplicate library row is
 * written; supply `script` + `title` and the previous behaviour is unchanged.
 * `createAvatarVideo` is deleted — see the ledger; it burned real D-ID credits and
 * then only `console.log`'d the provider job id, so the render was unpollable and
 * the agent paid for a video nothing could ever find.
 *
 * `createAvatarVideo`'s laxness is deliberately NOT ported: it defaulted a missing
 * avatar/voice to `""` and called the provider anyway. This path refuses instead.
 */
export async function generateVideoFromScript(params: {
  /** Required unless `scriptId` is given. */
  script?: string
  /** Required unless `scriptId` is given. */
  title?: string
  /** Render an existing `video_scripts_library` row instead of raw text. */
  scriptId?: string
  /**
   * The `public.scripts` row this render came from — a DIFFERENT table from
   * `scriptId` above, which names `video_scripts_library`. Recorded on the
   * project as source_script_id (m429) so the owner's viral rule can find it:
   * when the project passes VIRAL_VIEW_THRESHOLD views,
   * lib/video/viral-script-share.ts flips that script from the author's private
   * work to brokerage-shared. Tenant-checked inside createVideoProject.
   */
  sourceScriptId?: string
  type: "avatar" | "voice"
  avatarId?: string
  voiceId?: string
  userId?: string  // ignored — derived from session
}) {
  // Auth gate — the provider call burns paid credits under our key.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  try {
    // ─── Resolve the script: an existing library row, or raw text ────────────
    let script = params.script ?? ""
    let title = params.title ?? ""
    let sourceScriptId: string | null = null

    if (params.scriptId) {
      if (!isValidUUID(params.scriptId)) {
        return { success: false, error: "Invalid script ID" }
      }
      // Tenant check BEFORE any paid work — `error` destructured so a refused
      // read is not read as "no such script".
      const { data: scriptRow, error: scriptReadError } = await supabase
        .from("video_scripts_library")
        .select("id, brokerage_id, script_content, title")
        .eq("id", params.scriptId)
        .maybeSingle()
      if (scriptReadError) {
        return { success: false, error: `Could not read the script — ${scriptReadError.message}` }
      }
      if (!scriptRow) return { success: false, error: "Script not found" }
      if (scriptRow.brokerage_id !== auth.brokerageId) {
        return { success: false, error: "Forbidden" }
      }
      const storedScript = (scriptRow.script_content ?? "").trim()
      if (!storedScript) {
        return { success: false, error: "That script has no content to render" }
      }
      script = storedScript
      title = (params.title ?? scriptRow.title ?? "").trim() || "Untitled video"
      sourceScriptId = scriptRow.id as string
    }

    if (!script.trim()) {
      return { success: false, error: "A script is required" }
    }
    if (!title.trim()) title = "Untitled video"

    console.log("[v0] Generating video from script:", title)

    // Validate that agent has required settings
    if (params.type === "avatar" && !params.avatarId) {
      return { success: false, error: "Avatar ID not configured. Please set up in Agent Roster." }
    }
    if (!params.voiceId) {
      return { success: false, error: "Voice ID not configured. Please set up in Agent Roster." }
    }

    // THE PROJECT IS CREATED FIRST, AND THE QUEUE ROW POINTS AT IT.
    //
    // This used to insert a queue row carrying title/script/video_type/avatar/voice
    // — none of which are columns on video_generation_queue, so Supabase dropped
    // them and left a row with nothing but a status. Worse, the row had NO
    // project_id, and video_generation_queue.project_id is the only bridge to
    // ai_video_projects, the rail that actually finishes work. So this path
    // submitted a real D-ID job that NOTHING could ever poll: poll-did-videos
    // selects ai_video_projects rows, and there was no project. The row sat at
    // 'generating' forever.
    //
    // Creating the project restores the dropped metadata to columns that exist
    // AND puts the job on the rail that reaches a terminal state — the m365
    // trigger then mirrors that outcome back onto the queue row.
    // Through the CANONICAL creator, not a hand-rolled insert. createVideoProject
    // also resolves the video provider and stamps the provider columns, which a
    // bare insert here would skip — and it keeps ai_video_projects.agent_id
    // written from exactly one place. That column is mid-migration (it FKs
    // users(id) today and is scheduled to re-point to agents(id); see
    // scripts/agent-id-repoint-guard.ts), so adding a second writer that passes
    // a users id would have grown a backlog that is only allowed to shrink.
    const { createVideoProject } = await import("@/app/actions/video/create-video-project")
    const created = await createVideoProject({
      brokerageId:      auth.brokerageId ?? "",
      agentUserId:      auth.userId,
      title:            title,
      script:           script,
      // Mirrors ai_video_projects_video_type — an avatar talking head from a
      // supplied script is the explainer lane.
      videoType:        "avatar_explainer",
      avatarId:         params.avatarId,
      voiceId:          params.voiceId,
      backgroundType:   "solid",
      format:           "vertical",
      durationSeconds:  60,
      captionsEnabled:  true,
      // Passed through unverified ON PURPOSE — createVideoProject resolves it
      // inside the caller's brokerage and refuses a foreign id, so the check
      // lives in exactly one place alongside the campaignId one it mirrors.
      sourceScriptId:   params.sourceScriptId,
    })

    if (!created.success || !created.project) {
      console.error("[v0] Video project error:", created.error)
      throw new Error(created.error ?? "Failed to create video project")
    }
    const project = created.project

    const { data: queueRecord, error: queueError } = await supabase
      .from("video_generation_queue")
      .insert({
        project_id: project.id,
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
    //
    // SKIPPED when the caller named an existing library script: rendering a saved
    // script must not mint a second copy of it every time it is rendered.
    let scriptRecordId: string | null = sourceScriptId
    if (!sourceScriptId) {
      const { data: scriptRecord, error: scriptError } = await supabase
        .from("video_scripts_library")
        .insert({
          brokerage_id: auth.brokerageId,
          script_content: script,
          title: title,
          created_by: auth.userId,
          // "video" violated the script_type CHECK — every script record from this
          // path silently never persisted (error only console.warned).
          script_type: toLibraryScriptType("custom"),
          is_active: true,
        })
        .select()
        .single()

      if (scriptError) console.warn("[v0] Script record error:", scriptError)
      scriptRecordId = scriptRecord?.id ?? null
    }

    // Kick off generation via the platform engine — D-ID + ElevenLabs (no HeyGen).
    // Non-fatal: if the provider isn't configured the item stays queued for the
    // render pipeline. (Was a direct api.heygen.com call — business-rule violation.)
    if (params.avatarId && params.voiceId) {
      const { generateAvatarVideo } = await import("@/app/actions/external-services")
      const didRes = await generateAvatarVideo({
        avatarId: params.avatarId,
        voiceId: params.voiceId,
        script: script,
        brokerageId: auth.brokerageId ?? undefined,
      })
      const didJobId = (didRes as { videoId?: string }).videoId
      if (didRes.success && didJobId) {
        // Stamp the provider job onto the PROJECT. This is exactly what
        // poll-did-videos selects on: status='generating' AND provider_job_id
        // NOT NULL AND provider_metadata->>provider = 'did'. Without all three
        // the cron cannot see the job, which is why this path never finished.
        // mode 'talk' because lib/did/index.ts:generateVideo posts to /talks —
        // the cron reads this to choose talks vs clips vs expressives.
        const { error: kickError } = await supabase
          .from("ai_video_projects")
          .update({
            status:            "generating",
            provider_job_id:   didJobId,
            provider_status:   "processing",
            provider_metadata: { provider: "did", mode: "talk", talk_id: didJobId },
            error_message:     null,
          })
          .eq("id", project.id)
        // The queue row follows the project via the m365 trigger — it is not
        // set here, so there is exactly one writer of this lifecycle.
        if (kickError) console.error("[v0] D-ID job stamp failed:", kickError)
        console.log(`[v0] D-ID video_id=${didJobId} project=${project.id} queue=${queueRecord.id}`)
      } else {
        // The project stays 'draft' and the queue row stays 'queued'. Record WHY
        // on the project so the agent is told, rather than watching a queue row
        // that never moves.
        const reason = (didRes as { error?: string }).error ?? "provider not configured"
        await supabase
          .from("ai_video_projects")
          .update({ error_message: `Render not started: ${reason}` })
          .eq("id", project.id)
        console.warn("[v0] D-ID kick deferred, video stays queued:", reason)
      }
    }

    console.log("[v0] Video queued successfully:", queueRecord.id)
    // projectId is what every downstream video surface keys on (renders,
    // delivery, the reaper, the poll cron). Returning only the queue id left
    // callers holding the one id that nothing else in the video system uses.
    return { success: true, videoId: queueRecord.id, projectId: project.id, queueId: scriptRecordId }
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

// `createAvatarVideo` REMOVED (Wave 6) — duplicate.
// SURVIVOR: app/actions/video-generation.ts:generateVideoFromScript
//
// Same capability (saved script + avatar + voice → D-ID/ElevenLabs render), but
// this copy carried the exact defect the survivor was already fixed for: it called
// the provider FOR REAL, burning paid credits, then wrote the returned job id to
// `console.log` and nowhere else. `poll-did-videos` selects `ai_video_projects`
// rows on (status='generating' AND provider_job_id NOT NULL AND
// provider_metadata->>provider='did'); this path created no project at all, so the
// render was unpollable forever and the agent paid for a video nothing could find —
// while the function returned `{ success: true, status: "generating" }`.
// It also defaulted a missing avatar/voice to `""` and called the provider anyway.
//
// MERGED FIRST, then deleted: its one genuine capability — rendering a script
// already in `video_scripts_library` by id, with the tenant check, instead of
// re-posting raw text — is now `generateVideoFromScript({ scriptId, ... })`, which
// also skips minting a duplicate library row for a script that already exists.
// The `""`-avatar laxness was deliberately NOT ported; the survivor refuses.
