import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { resolveProvider } from "@/lib/kernel/providers"

const HEYGEN_API_BASE = "https://api.heygen.com/v2"

/**
 * POST /api/heygen/voice-clone/start
 * Starts voice clone training with HeyGen
 * 
 * Body:
 * - training_id: string (voice_clone_training.id)
 * - profile_id: string (agent_voice_profiles.id)
 * - brokerage_id: string
 * - user_id?: string (actor)
 * - sample_audio_urls: string[] (audio file URLs for training)
 * - voice_name: string (name for the cloned voice)
 */
export async function POST(request: NextRequest) {
  // Auth guard — brokerage_id and user_id always from session
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json()

    const {
      training_id,
      profile_id,
      sample_audio_urls,
      voice_name,
    } = body

    // Always use session-resolved values — never trust body-supplied IDs
    const brokerage_id = auth.brokerageId
    const user_id = auth.userId

    // ─── VALIDATION ───────────────────────────────────────────────────────────
    if (!training_id || !profile_id || !sample_audio_urls || !voice_name) {
      return NextResponse.json(
        { error: "Missing required fields: training_id, profile_id, sample_audio_urls, voice_name" },
        { status: 400 }
      )
    }

    if (!Array.isArray(sample_audio_urls) || sample_audio_urls.length < 5) {
      return NextResponse.json(
        { error: "At least 5 audio samples are required for voice cloning" },
        { status: 400 }
      )
    }

    // ─── CHECK HEYGEN API KEY ─────────────────────────────────────────────────
    const heygenApiKey = process.env.HEYGEN_API_KEY
    if (!heygenApiKey) {
      // Update training status to indicate API key not configured
      await supabase
        .from("voice_clone_training")
        .update({
          status: "pending",
          error_message: "HeyGen API key not configured",
        })
        .eq("id", training_id)

      return NextResponse.json({
        success: false,
        error: "HeyGen API key not configured. Training queued for processing.",
        queued: true,
      })
    }

    // ─── UPDATE TRAINING STATUS TO PROCESSING ─────────────────────────────────
    await supabase
      .from("voice_clone_training")
      .update({
        status: "processing",
        started_at: new Date().toISOString(),
      })
      .eq("id", training_id)

    await supabase
      .from("agent_voice_profiles")
      .update({
        training_status: "processing",
        updated_at: new Date().toISOString(),
      })
      .eq("id", profile_id)

    // ─── SUBMIT TO HEYGEN VOICE CLONE API ─────────────────────────────────────
    // HeyGen uses the Voice Clone API endpoint
    const heygenResponse = await fetch(`${HEYGEN_API_BASE}/voice/instant_clone`, {
      method: "POST",
      headers: {
        "X-Api-Key": heygenApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        voice_name: voice_name,
        audio_files: sample_audio_urls,
        language: "en-US",
      }),
    })

    const heygenData = await heygenResponse.json()

    if (!heygenResponse.ok) {
      console.error("[HeyGen Voice Clone] API error:", heygenData)

      // Update training status on failure
      await supabase
        .from("voice_clone_training")
        .update({
          status: "failed",
          error_message: heygenData.message || "HeyGen API error",
          provider_response: heygenData,
          completed_at: new Date().toISOString(),
        })
        .eq("id", training_id)

      await supabase
        .from("agent_voice_profiles")
        .update({
          training_status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", profile_id)

      // Write lifecycle event for failure
      await supabase.from("lifecycle_events").insert({
        entity_type: "voice_training",
        entity_id: training_id,
        brokerage_id,
        event_type: KernelEvent.VOICE_CLONE_TRAINING_FAILED,
        actor_user_id: user_id ?? null,
        metadata: { error: heygenData.message || "HeyGen API error" },
      })

      return NextResponse.json(
        { success: false, error: heygenData.message || "HeyGen API error" },
        { status: 500 }
      )
    }

    // ─── HANDLE SUCCESS RESPONSE ──────────────────────────────────────────────
    // HeyGen may return the voice_id immediately or require polling
    const voiceId = heygenData.data?.voice_id
    const trainingJobId = heygenData.data?.job_id || heygenData.data?.training_id

    // If we got a voice_id immediately, training is complete
    if (voiceId && !trainingJobId) {
      // Instant clone completed
      await supabase
        .from("voice_clone_training")
        .update({
          status: "completed",
          training_job_id: voiceId,
          provider_response: heygenData.data,
          completed_at: new Date().toISOString(),
        })
        .eq("id", training_id)

      await supabase
        .from("agent_voice_profiles")
        .update({
          training_status: "completed",
          heygen_voice_clone_id: voiceId,
          quality_score: heygenData.data?.quality_score ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", profile_id)

      // Write lifecycle events
      await supabase.from("lifecycle_events").insert({
        entity_type: "voice_training",
        entity_id: training_id,
        brokerage_id,
        event_type: KernelEvent.VOICE_CLONE_TRAINING_COMPLETED,
        actor_user_id: user_id ?? null,
        metadata: { voice_id: voiceId },
      })

      // Fire VOICE_CLONE_READY event
      await supabase.from("lifecycle_events").insert({
        entity_type: "voice_profile",
        entity_id: profile_id,
        brokerage_id,
        event_type: KernelEvent.VOICE_CLONE_READY,
        actor_user_id: user_id ?? null,
        metadata: { 
          training_id, 
          voice_id: voiceId,
          quality_score: heygenData.data?.quality_score ?? null,
        },
      })

      await processKernelEvent({
        event: KernelEvent.VOICE_CLONE_READY,
        brokerageId: brokerage_id,
        entityType: "voice_profile",
        entityId: profile_id,
      }).catch(err => console.error("[HeyGen Voice Clone] Kernel event failed:", err))

      return NextResponse.json({
        success: true,
        status: "completed",
        voice_id: voiceId,
        quality_score: heygenData.data?.quality_score ?? null,
      })
    }

    // If we have a job_id, update training record for polling
    if (trainingJobId) {
      await supabase
        .from("voice_clone_training")
        .update({
          training_job_id: trainingJobId,
          provider_response: heygenData.data,
        })
        .eq("id", training_id)

      return NextResponse.json({
        success: true,
        status: "processing",
        training_job_id: trainingJobId,
        estimated_completion_minutes: 10,
      })
    }

    // Fallback - unexpected response format
    console.warn("[HeyGen Voice Clone] Unexpected response format:", heygenData)
    return NextResponse.json({
      success: true,
      status: "processing",
      provider_response: heygenData.data,
    })

  } catch (error: any) {
    console.error("[HeyGen Voice Clone] start error:", error)
    return NextResponse.json(
      { error: "Failed to start voice clone training", details: error.message },
      { status: 500 }
    )
  }
}
