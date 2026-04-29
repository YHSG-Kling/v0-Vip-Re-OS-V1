import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { resolveProvider } from "@/lib/kernel/providers"

const HEYGEN_API_BASE = "https://api.heygen.com/v2"

// ─── KERNEL GOVERNANCE CHECKS ───────────────────────────────────────────────
async function validateScriptApproval(supabase: any, scriptId: string | null): Promise<{ valid: boolean; error?: string }> {
  if (!scriptId) return { valid: true } // Allow ad-hoc scripts without approval for now

  const { data: script, error } = await supabase
    .from("video_scripts_library")
    .select("approval_status, compliance_review_notes")
    .eq("id", scriptId)
    .maybeSingle()

  if (error || !script) {
    return { valid: false, error: "Script not found" }
  }

  if (script.approval_status !== "approved") {
    return { valid: false, error: `Script must be approved before generation. Current status: ${script.approval_status}` }
  }

  return { valid: true }
}

async function validateBrandingAssets(supabase: any, presetId: string | null, brokerageId: string): Promise<{ valid: boolean; error?: string }> {
  if (!presetId) {
    // Check if brokerage requires branding preset
    const { data: brokerage } = await supabase
      .from("brokerages")
      .select("id")
      .eq("id", brokerageId)
      .maybeSingle()

    if (brokerage) {
      console.warn(`[HeyGen] Video generation without branding preset for brokerage ${brokerageId}`)
    }
    return { valid: true }
  }

  const { data: preset, error } = await supabase
    .from("video_branding_presets")
    .select("logo_url, preset_name")
    .eq("id", presetId)
    .maybeSingle()

  if (error || !preset) {
    return { valid: false, error: "Branding preset not found" }
  }

  return { valid: true }
}

async function validateComplianceAssets(brokerageId: string): Promise<{ valid: boolean; error?: string }> {
  // Placeholder for compliance asset validation
  // In production, check for mandatory disclaimers, contact overlays, etc.
  return { valid: true }
}

// ─── WRITE LIFECYCLE EVENT ──────────────────────────────────────────────────
async function writeLifecycleEvent(
  supabase: any,
  entityId: string,
  brokerageId: string,
  eventType: KernelEvent,
  actorUserId: string | null,
  metadata: Record<string, any>
) {
  await supabase.from("lifecycle_events").insert({
    entity_type: "video_project",
    entity_id: entityId,
    brokerage_id: brokerageId,
    event_type: eventType,
    actor_user_id: actorUserId,
    metadata,
  })
}

export async function POST(request: NextRequest) {
  // Auth guard — brokerage_id and user_id always from session
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json()

    const {
      // Required fields (brokerage_id and user_id intentionally NOT taken from body)
      script,
      avatar_id,
      voice_id,
      video_project_id,
      // Optional configuration
      background,
      script_id,
      branding_preset_id,
      quality_preset = "1080p",
      output_orientation = "landscape",
      aspect_ratio = "16:9",
    } = body

    // Always use session-resolved values — never trust body-supplied IDs
    const brokerage_id = auth.brokerageId
    const user_id = auth.userId

    // ─── VALIDATION ───────────────────────────────────────────────────────────
    if (!script || !avatar_id || !voice_id || !video_project_id) {
      return NextResponse.json(
        { error: "Missing required fields: script, avatar_id, voice_id, video_project_id" },
        { status: 400 }
      )
    }

    // ─── KERNEL GOVERNANCE: SCRIPT APPROVAL ───────────────────────────────────
    const scriptValidation = await validateScriptApproval(supabase, script_id)
    if (!scriptValidation.valid) {
      await supabase
        .from("ai_video_projects")
        .update({
          status: "blocked",
          error_message: `Kernel governance blocked: ${scriptValidation.error}`,
        })
        .eq("id", video_project_id)

      return NextResponse.json(
        { success: false, error: scriptValidation.error, blocked: true },
        { status: 403 }
      )
    }

    // ─── KERNEL GOVERNANCE: BRANDING VALIDATION ───────────────────────────────
    const brandingValidation = await validateBrandingAssets(supabase, branding_preset_id, brokerage_id)
    if (!brandingValidation.valid) {
      await supabase
        .from("ai_video_projects")
        .update({
          status: "blocked",
          error_message: `Kernel governance blocked: ${brandingValidation.error}`,
        })
        .eq("id", video_project_id)

      return NextResponse.json(
        { success: false, error: brandingValidation.error, blocked: true },
        { status: 403 }
      )
    }

    // ─── KERNEL GOVERNANCE: COMPLIANCE VALIDATION ─────────────────────────────
    const complianceValidation = await validateComplianceAssets(brokerage_id)
    if (!complianceValidation.valid) {
      await supabase
        .from("ai_video_projects")
        .update({
          status: "blocked",
          error_message: `Kernel governance blocked: ${complianceValidation.error}`,
        })
        .eq("id", video_project_id)

      return NextResponse.json(
        { success: false, error: complianceValidation.error, blocked: true },
        { status: 403 }
      )
    }

    // ─── CHECK HEYGEN API KEY ─────────────────────────────────────────────────
    const heygenApiKey = process.env.HEYGEN_API_KEY
    if (!heygenApiKey) {
      // Mark as queued for later processing when API key is available
      await supabase
        .from("ai_video_projects")
        .update({
          status: "pending",
          heygen_status: "pending",
          error_message: "HeyGen API key not configured",
        })
        .eq("id", video_project_id)

      // Still write lifecycle event for tracking
      await writeLifecycleEvent(
        supabase,
        video_project_id,
        brokerage_id,
        KernelEvent.VIDEO_GENERATION_REQUESTED,
        user_id,
        { queued: true, reason: "api_key_not_configured" }
      )

      return NextResponse.json({
        success: false,
        error: "HeyGen API key not configured. Video queued for processing.",
        queued: true,
      })
    }

    // ─── PREPARE VIDEO DIMENSIONS ─────────────────────────────────────────────
    const dimensions = {
      landscape: { width: 1920, height: 1080 },
      portrait: { width: 1080, height: 1920 },
      square: { width: 1080, height: 1080 },
    }
    const dim = dimensions[output_orientation as keyof typeof dimensions] || dimensions.landscape

    // ─── SUBMIT TO HEYGEN API ─────────────────────────────────────────────────
    const heygenResponse = await fetch(`${HEYGEN_API_BASE}/video/generate`, {
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
              avatar_id: avatar_id,
              avatar_style: "normal",
            },
            voice: {
              type: "text",
              input_text: script,
              voice_id: voice_id,
            },
            background: background || {
              type: "color",
              value: "#ffffff",
            },
          },
        ],
        dimension: dim,
        aspect_ratio: aspect_ratio,
      }),
    })

    const heygenData = await heygenResponse.json()

    if (!heygenResponse.ok) {
      console.error("[HeyGen] API error:", heygenData)

      await supabase
        .from("ai_video_projects")
        .update({
          status: "failed",
          heygen_status: "failed",
          error_message: heygenData.message || "HeyGen API error",
          retry_count: 1,
        })
        .eq("id", video_project_id)

      // Write lifecycle event for failure
      await writeLifecycleEvent(
        supabase,
        video_project_id,
        brokerage_id,
        KernelEvent.VIDEO_GENERATION_FAILED,
        user_id,
        { error: heygenData.message || "HeyGen API error" }
      )

      return NextResponse.json(
        { success: false, error: heygenData.message || "HeyGen API error" },
        { status: 500 }
      )
    }

    const heygenVideoId = heygenData.data?.video_id

    // ─── UPDATE AI_VIDEO_PROJECTS ─────────────────────────────────────────────
    await supabase
      .from("ai_video_projects")
      .update({
        heygen_video_id: heygenVideoId,
        heygen_status: "generating",
        heygen_avatar_id: avatar_id,
        heygen_voice_id: voice_id,
        status: "generating",
        error_message: null,
        provider_job_id: heygenVideoId,
        provider_status: "processing",
        provider_metadata: {
          quality_preset,
          output_orientation,
          aspect_ratio,
          dimensions: dim,
        },
      })
      .eq("id", video_project_id)

    // ─── ADD TO VIDEO_GENERATION_QUEUE ────────────────────────────────────────
    await supabase.from("video_generation_queue").insert({
      project_id: video_project_id,
      priority: 5,
      status: "processing",
    })

    // ─── CREATE OR UPDATE VIDEO_STREAMING_STATUS ──────────────────────────────
    await supabase.from("video_streaming_status").upsert({
      video_project_id: video_project_id,
      brokerage_id: brokerage_id,
      stream_status: "pending",
      quality_preset: quality_preset,
      output_format: aspect_ratio === "9:16" ? "vertical" : "horizontal",
      last_polled_at: new Date().toISOString(),
    }, { onConflict: "video_project_id" })

    // ─── WRITE LIFECYCLE EVENT: VIDEO_GENERATION_REQUESTED ────────────────────
    await writeLifecycleEvent(
      supabase,
      video_project_id,
      brokerage_id,
      KernelEvent.VIDEO_GENERATION_REQUESTED,
      user_id,
      {
        heygen_video_id: heygenVideoId,
        avatar_id,
        voice_id,
        quality_preset,
        output_orientation,
      }
    )

    // ─── FIRE KERNEL EVENT ────────────────────────────────────────────────────
    await processKernelEvent({
      event: KernelEvent.VIDEO_GENERATION_REQUESTED,
      brokerageId: brokerage_id,
      entityType: "video_project",
      entityId: video_project_id,
    }).catch(err => console.error("[HeyGen] Kernel event failed:", err))

    return NextResponse.json({
      success: true,
      heygen_video_id: heygenVideoId,
      estimated_completion_minutes: 15,
      status: "generating",
    })
  } catch (error: any) {
    console.error("[HeyGen] generate video error:", error)
    return NextResponse.json(
      { error: "Failed to generate video", details: error.message },
      { status: 500 }
    )
  }
}
