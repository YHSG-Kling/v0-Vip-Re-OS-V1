import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

const HEYGEN_API_BASE = "https://api.heygen.com/v2"

/**
 * GET /api/heygen/voice-clone/status/[training_id]
 * Check the status of a voice clone training job
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ training_id: string }> }
) {
  try {
    const { training_id } = await params
    
    if (!training_id) {
      return NextResponse.json(
        { error: "Missing training_id" },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    // Get training job from database
    const { data: trainingJob, error: fetchError } = await supabase
      .from("voice_clone_training")
      .select(`
        *,
        agent_voice_profiles(id, profile_name, training_status, heygen_voice_clone_id, quality_score)
      `)
      .eq("id", training_id)
      .single()

    if (fetchError || !trainingJob) {
      return NextResponse.json(
        { error: "Training job not found" },
        { status: 404 }
      )
    }

    // If already completed or failed, return cached status
    if (trainingJob.status === "completed" || trainingJob.status === "failed") {
      return NextResponse.json({
        success: true,
        training_id,
        status: trainingJob.status,
        voice_id: trainingJob.agent_voice_profiles?.heygen_voice_clone_id ?? null,
        quality_score: trainingJob.agent_voice_profiles?.quality_score ?? null,
        error_message: trainingJob.error_message,
        completed_at: trainingJob.completed_at,
      })
    }

    // If no HeyGen job ID, return current status
    if (!trainingJob.training_job_id) {
      return NextResponse.json({
        success: true,
        training_id,
        status: trainingJob.status,
        message: "Waiting for HeyGen job to be created",
      })
    }

    // ─── POLL HEYGEN API ──────────────────────────────────────────────────────
    const heygenApiKey = process.env.HEYGEN_API_KEY
    if (!heygenApiKey) {
      return NextResponse.json({
        success: true,
        training_id,
        status: trainingJob.status,
        message: "HeyGen API key not configured - cannot poll status",
      })
    }

    // Check status with HeyGen
    const heygenResponse = await fetch(
      `${HEYGEN_API_BASE}/voice/clone_status?job_id=${trainingJob.training_job_id}`,
      {
        method: "GET",
        headers: {
          "X-Api-Key": heygenApiKey,
          "Content-Type": "application/json",
        },
      }
    )

    const heygenData = await heygenResponse.json()

    if (!heygenResponse.ok) {
      console.error("[HeyGen Voice Clone Status] API error:", heygenData)
      return NextResponse.json({
        success: true,
        training_id,
        status: trainingJob.status,
        heygen_error: heygenData.message || "Failed to fetch status from HeyGen",
      })
    }

    // ─── PROCESS HEYGEN STATUS ────────────────────────────────────────────────
    const heygenStatus = heygenData.data?.status?.toLowerCase()
    const voiceId = heygenData.data?.voice_id
    const qualityScore = heygenData.data?.quality_score ?? null

    // Map HeyGen status to our status
    let newStatus = trainingJob.status
    if (heygenStatus === "completed" || heygenStatus === "success" || heygenStatus === "ready") {
      newStatus = "completed"
    } else if (heygenStatus === "failed" || heygenStatus === "error") {
      newStatus = "failed"
    } else if (heygenStatus === "processing" || heygenStatus === "training") {
      newStatus = "processing"
    }

    // If status changed, update database
    if (newStatus !== trainingJob.status) {
      await updateTrainingStatus(
        training_id,
        trainingJob.voice_profile_id,
        trainingJob.brokerage_id,
        newStatus,
        voiceId,
        qualityScore,
        heygenData.data,
        heygenStatus === "failed" ? (heygenData.data?.error || "Training failed") : null
      )
    }

    return NextResponse.json({
      success: true,
      training_id,
      status: newStatus,
      voice_id: newStatus === "completed" ? voiceId : null,
      quality_score: qualityScore,
      heygen_status: heygenStatus,
      error_message: newStatus === "failed" ? (heygenData.data?.error || "Training failed") : null,
    })

  } catch (error: any) {
    console.error("[HeyGen Voice Clone Status] error:", error)
    return NextResponse.json(
      { error: "Failed to check training status", details: error.message },
      { status: 500 }
    )
  }
}

/**
 * Helper to update training status and fire kernel events
 */
async function updateTrainingStatus(
  trainingId: string,
  profileId: string,
  brokerageId: string,
  status: string,
  voiceId: string | null,
  qualityScore: number | null,
  providerResponse: any,
  errorMessage: string | null
) {
  const supabase = createServiceClient()

  // Update training job
  const trainingUpdate: Record<string, any> = {
    status,
    provider_response: providerResponse,
  }

  if (status === "completed" || status === "failed") {
    trainingUpdate.completed_at = new Date().toISOString()
  }

  if (errorMessage) {
    trainingUpdate.error_message = errorMessage
  }

  await supabase
    .from("voice_clone_training")
    .update(trainingUpdate)
    .eq("id", trainingId)

  // Update voice profile
  const profileUpdate: Record<string, any> = {
    training_status: status,
    updated_at: new Date().toISOString(),
  }

  if (status === "completed" && voiceId) {
    profileUpdate.heygen_voice_clone_id = voiceId
    if (qualityScore !== null) {
      profileUpdate.quality_score = qualityScore
    }
  }

  await supabase
    .from("agent_voice_profiles")
    .update(profileUpdate)
    .eq("id", profileId)

  // Write lifecycle events
  if (status === "completed") {
    await supabase.from("lifecycle_events").insert({
      entity_type: "voice_training",
      entity_id: trainingId,
      brokerage_id: brokerageId,
      event_type: KernelEvent.VOICE_CLONE_TRAINING_COMPLETED,
      metadata: { voice_id: voiceId, quality_score: qualityScore },
    })

    // Check quality threshold before marking as ready
    const effectiveQuality = qualityScore ?? 100
    if (effectiveQuality >= 70) {
      await supabase.from("lifecycle_events").insert({
        entity_type: "voice_profile",
        entity_id: profileId,
        brokerage_id: brokerageId,
        event_type: KernelEvent.VOICE_CLONE_READY,
        metadata: { 
          training_id: trainingId, 
          voice_id: voiceId,
          quality_score: qualityScore,
        },
      })

      await processKernelEvent({
        event: KernelEvent.VOICE_CLONE_READY,
        brokerageId,
        entityType: "voice_profile",
        entityId: profileId,
      }).catch(err => console.error("[HeyGen Voice Clone Status] Kernel event failed:", err))
    } else {
      console.warn(`[HeyGen Voice Clone Status] Quality ${qualityScore}% below threshold, not marking as ready`)
    }
  } else if (status === "failed") {
    await supabase.from("lifecycle_events").insert({
      entity_type: "voice_training",
      entity_id: trainingId,
      brokerage_id: brokerageId,
      event_type: KernelEvent.VOICE_CLONE_TRAINING_FAILED,
      metadata: { error: errorMessage },
    })
  }
}
