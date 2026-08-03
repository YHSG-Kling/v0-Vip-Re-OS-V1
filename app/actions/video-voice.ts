"use server"

// ============================================
// Layer 8.3 — Voice Clone Engine Actions
// CANONICAL TABLE: public.agent_voice_profiles, public.voice_clone_training
// ============================================

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import type { VoiceTrainingStatus, VoiceProfile, VoiceTrainingJob, SampleManifest, UploadedSample } from "./video-voice.types"
import { VOICE_CLONE_SAMPLE_PHRASES } from "./video-voice.constants"

// ============================================
// VOICE PROFILE CRUD
// ============================================

/**
 * Get all voice profiles for an agent
 * CRITICAL: agent_id references agents.id, not users.id
 */
export async function getVoiceProfiles(agentId: string) {
  if (!isValidUUID(agentId)) return []

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agent_voice_profiles")
    .select(`
      *,
      voice_clone_training(id, status, started_at, completed_at, error_message)
    `)
    .eq("agent_id", agentId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[video-voice] Error fetching voice profiles:", error)
    return []
  }

  return data || []
}

/**
 * Get a single voice profile by ID
 */
export async function getVoiceProfileById(profileId: string) {
  if (!isValidUUID(profileId)) return null

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agent_voice_profiles")
    .select(`
      *,
      voice_clone_training(*)
    `)
    .eq("id", profileId)
    .single()

  if (error) {
    console.error("[video-voice] Error fetching voice profile:", error)
    return null
  }

  return data
}

/**
 * Create a new voice profile
 * CRITICAL IDENTITY RULE: Must pass agents.id NOT users.id
 */
export async function createVoiceProfile(data: {
  brokerageId: string
  agentId: string // This MUST be agents.id, not users.id
  profileName: string
  actorUserId?: string
}) {
  if (!isValidUUID(data.brokerageId) || !isValidUUID(data.agentId)) {
    throw new Error("Invalid brokerage or agent ID")
  }

  const supabase = await createClient()

  // Create the voice profile
  const { data: profile, error } = await supabase
    .from("agent_voice_profiles")
    .insert({
      brokerage_id: data.brokerageId,
      agent_id: data.agentId,
      profile_name: data.profileName,
      training_status: "not_started",
      sample_count: 0,
      is_default: false,
    })
    .select()
    .single()

  if (error) {
    console.error("[video-voice] Error creating voice profile:", error)
    throw error
  }

  // Write lifecycle event — kernel-visible
  await supabase.from("lifecycle_events").insert({
    entity_type: "voice_profile",
    entity_id: profile.id,
    brokerage_id: data.brokerageId,
    event_type: KernelEvent.VOICE_CLONE_PROFILE_CREATED,
    actor_user_id: data.actorUserId ?? null,
    metadata: {
      profile_name: data.profileName,
      agent_id: data.agentId,
    },
  })

  // Fire kernel event
  await processKernelEvent({
    event: KernelEvent.VOICE_CLONE_PROFILE_CREATED,
    brokerageId: data.brokerageId,
    entityType: "voice_profile",
    entityId: profile.id,
  }).catch(err => console.error("[video-voice] Kernel event failed:", err))

  revalidatePath("/dashboard/videos/voice")
  return profile
}

/**
 * Update voice profile sample manifest
 */
export async function updateVoiceProfileSamples(
  profileId: string,
  brokerageId: string,
  sampleManifest: SampleManifest,
  actorUserId?: string
) {
  if (!isValidUUID(profileId) || !isValidUUID(brokerageId)) {
    throw new Error("Invalid profile or brokerage ID")
  }

  const supabase = await createClient()

  // Count recorded samples
  const recordedCount = (sampleManifest.phrases ?? []).filter(p => p.status === "recorded" || p.status === "validated").length

  // Update the profile
  const { data: profile, error } = await supabase
    .from("agent_voice_profiles")
    .update({
      sample_count: recordedCount,
      // agent_voice_profiles.training_status ∈ (not_started, collecting_samples,
      // training, ready, failed). This wrote "pending", which the CHECK rejects —
      // so every mid-recording save was refused and sample_count never advanced
      // past its first value. Any recording in progress IS collecting_samples.
      training_status: recordedCount > 0 ? "collecting_samples" : "not_started",
      updated_at: new Date().toISOString(),
    })
    .eq("id", profileId)
    .eq("brokerage_id", brokerageId)
    .select()
    .single()

  if (error) {
    console.error("[video-voice] Error updating voice profile samples:", error)
    throw error
  }

  // Write lifecycle event
  await supabase.from("lifecycle_events").insert({
    entity_type: "voice_profile",
    entity_id: profileId,
    brokerage_id: brokerageId,
    event_type: KernelEvent.VOICE_CLONE_SAMPLE_UPLOADED,
    actor_user_id: actorUserId ?? null,
    metadata: {
      sample_count: recordedCount,
      total_required: VOICE_CLONE_SAMPLE_PHRASES.length,
    },
  })

  revalidatePath("/dashboard/videos/voice")
  return profile
}

/**
 * Set a voice profile as default
 */
export async function setDefaultVoiceProfile(
  profileId: string,
  agentId: string,
  brokerageId: string,
  actorUserId?: string
) {
  if (!isValidUUID(profileId) || !isValidUUID(agentId) || !isValidUUID(brokerageId)) {
    throw new Error("Invalid IDs provided")
  }

  const supabase = await createClient()

  // First, unset all existing defaults for this agent
  await supabase
    .from("agent_voice_profiles")
    .update({ is_default: false })
    .eq("agent_id", agentId)

  // Set the new default
  const { data: profile, error } = await supabase
    .from("agent_voice_profiles")
    .update({
      is_default: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", profileId)
    .eq("brokerage_id", brokerageId)
    .select()
    .single()

  if (error) {
    console.error("[video-voice] Error setting default voice profile:", error)
    throw error
  }

  // Write lifecycle event
  await supabase.from("lifecycle_events").insert({
    entity_type: "voice_profile",
    entity_id: profileId,
    brokerage_id: brokerageId,
    event_type: KernelEvent.VOICE_CLONE_DEFAULT_SET,
    actor_user_id: actorUserId ?? null,
    metadata: { agent_id: agentId },
  })

  await processKernelEvent({
    event: KernelEvent.VOICE_CLONE_DEFAULT_SET,
    brokerageId,
    entityType: "voice_profile",
    entityId: profileId,
  }).catch(err => console.error("[video-voice] Kernel event failed:", err))

  revalidatePath("/dashboard/videos/voice")
  revalidatePath("/dashboard/videos/create")
  return profile
}

/**
 * Get the default voice profile for an agent
 */
export async function getDefaultVoiceProfile(agentId: string) {
  if (!isValidUUID(agentId)) return null

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agent_voice_profiles")
    .select("*")
    .eq("agent_id", agentId)
    .eq("is_default", true)
    .eq("training_status", "ready")
    .maybeSingle()

  if (error) {
    console.error("[video-voice] Error fetching default voice profile:", error)
    return null
  }

  return data
}

// ============================================
// VOICE CLONE TRAINING
// ============================================

/**
 * Start voice clone training job
 * Creates a voice_clone_training record and returns the training ID
 */
export async function startVoiceCloneTraining(
  profileId: string,
  brokerageId: string,
  sampleManifest: SampleManifest,
  actorUserId?: string
) {
  if (!isValidUUID(profileId) || !isValidUUID(brokerageId)) {
    throw new Error("Invalid profile or brokerage ID")
  }

  const supabase = await createClient()

  // Validate we have enough samples
  const recordedCount = (sampleManifest.phrases ?? []).filter(p => p.status === "recorded" || p.status === "validated").length
  if (recordedCount < VOICE_CLONE_SAMPLE_PHRASES.length) {
    throw new Error(`Not enough samples. Required: ${VOICE_CLONE_SAMPLE_PHRASES.length}, Recorded: ${recordedCount}`)
  }

  // Create training job record
  const { data: trainingJob, error: trainingError } = await supabase
    .from("voice_clone_training")
    .insert({
      voice_profile_id: profileId,
      brokerage_id: brokerageId,
      provider: "elevenlabs",
      status: "queued",
      sample_manifest: sampleManifest,
    })
    .select()
    .single()

  if (trainingError) {
    console.error("[video-voice] Error creating training job:", trainingError)
    throw trainingError
  }

  // Update profile status
  await supabase
    .from("agent_voice_profiles")
    .update({
      training_status: "training",
      updated_at: new Date().toISOString(),
    })
    .eq("id", profileId)

  // Write lifecycle event — KERNEL-VISIBLE
  await supabase.from("lifecycle_events").insert({
    entity_type: "voice_training",
    entity_id: trainingJob.id,
    brokerage_id: brokerageId,
    event_type: KernelEvent.VOICE_CLONE_TRAINING_STARTED,
    actor_user_id: actorUserId ?? null,
    metadata: {
      profile_id: profileId,
      sample_count: recordedCount,
    },
  })

  // Fire kernel event
  await processKernelEvent({
    event: KernelEvent.VOICE_CLONE_TRAINING_STARTED,
    brokerageId,
    entityType: "voice_training",
    entityId: trainingJob.id,
  }).catch(err => console.error("[video-voice] Kernel event failed:", err))

  revalidatePath("/dashboard/videos/voice")
  return trainingJob
}

/**
 * Update training job status from provider webhook/polling
 */
export async function updateTrainingJobStatus(
  trainingId: string,
  status: VoiceTrainingStatus,
  providerResponse?: Record<string, any>,
  errorMessage?: string
) {
  if (!isValidUUID(trainingId)) {
    throw new Error("Invalid training ID")
  }

  const supabase = createServiceClient()

  // Get the training job to find profile and brokerage
  const { data: job } = await supabase
    .from("voice_clone_training")
    .select("voice_profile_id, brokerage_id")
    .eq("id", trainingId)
    .single()

  if (!job) {
    throw new Error("Training job not found")
  }

  const updateData: Record<string, any> = {
    status,
    provider_response: providerResponse ?? null,
  }

  if (status === "processing") {
    updateData.started_at = new Date().toISOString()
  }

  if (status === "completed" || status === "failed") {
    updateData.completed_at = new Date().toISOString()
  }

  if (errorMessage) {
    updateData.error_message = errorMessage
  }

  // Update training job
  const { error: updateError } = await supabase
    .from("voice_clone_training")
    .update(updateData)
    .eq("id", trainingId)

  if (updateError) {
    console.error("[video-voice] Error updating training job:", updateError)
    throw updateError
  }

  // Update profile status.
  //
  // TWO VOCABULARIES, ONE VARIABLE. `status` here is the TRAINING JOB's status
  // (processing | completed | failed). agent_voice_profiles.training_status is a
  // different set (not_started | collecting_samples | training | ready | failed).
  // Copying the job status straight across wrote "completed", which that column
  // rejects — and elevenlabs_voice_id is set in this SAME update, so the clone id
  // returned by ElevenLabs was never saved. The voice was cloned and the pointer
  // to it thrown away.
  const PROFILE_STATUS_FOR_JOB: Record<string, string> = {
    processing: "training",
    completed:  "ready",
    failed:     "failed",
  }
  const profileUpdate: Record<string, any> = {
    training_status: PROFILE_STATUS_FOR_JOB[status] ?? "training",
    updated_at: new Date().toISOString(),
  }

  // If completed successfully, save the voice clone ID and quality score
  if (status === "completed" && providerResponse?.voice_id) {
    profileUpdate.elevenlabs_voice_id = providerResponse.voice_id

    // Quality check — do not auto-mark as usable if quality is below threshold
    const qualityScore = providerResponse.quality_score ?? providerResponse.score ?? null
    if (qualityScore !== null) {
      profileUpdate.quality_score = qualityScore
      
      // If quality is below 70%, keep status as "completed" but log warning
      if (qualityScore < 70) {
        console.warn(`[video-voice] Voice clone quality below threshold: ${qualityScore}%`)
      }
    }
  }

  await supabase
    .from("agent_voice_profiles")
    .update(profileUpdate)
    .eq("id", job.voice_profile_id)

  // Write lifecycle event
  const eventType = status === "completed" 
    ? KernelEvent.VOICE_CLONE_TRAINING_COMPLETED
    : status === "failed"
      ? KernelEvent.VOICE_CLONE_TRAINING_FAILED
      : KernelEvent.VOICE_CLONE_TRAINING_STARTED

  await supabase.from("lifecycle_events").insert({
    entity_type: "voice_training",
    entity_id: trainingId,
    brokerage_id: job.brokerage_id,
    event_type: eventType,
    metadata: {
      status,
      profile_id: job.voice_profile_id,
      quality_score: providerResponse?.quality_score ?? null,
      error_message: errorMessage ?? null,
    },
  })

  // Fire VOICE_CLONE_READY if completed with acceptable quality
  if (status === "completed") {
    const qualityScore = providerResponse?.quality_score ?? 100
    if (qualityScore >= 70) {
      await supabase.from("lifecycle_events").insert({
        entity_type: "voice_profile",
        entity_id: job.voice_profile_id,
        brokerage_id: job.brokerage_id,
        event_type: KernelEvent.VOICE_CLONE_READY,
        metadata: {
          training_id: trainingId,
          voice_id: providerResponse?.voice_id,
          quality_score: qualityScore,
        },
      })

      await processKernelEvent({
        event: KernelEvent.VOICE_CLONE_READY,
        brokerageId: job.brokerage_id,
        entityType: "voice_profile",
        entityId: job.voice_profile_id,
      }).catch(err => console.error("[video-voice] Kernel event failed:", err))
    }
  }

  revalidatePath("/dashboard/videos/voice")
}

/**
 * Get training job status
 */
export async function getTrainingJobStatus(trainingId: string) {
  if (!isValidUUID(trainingId)) return null

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("voice_clone_training")
    .select("*")
    .eq("id", trainingId)
    .single()

  if (error) {
    console.error("[video-voice] Error fetching training job:", error)
    return null
  }

  return data
}

// ============================================
// HELPER: Resolve agents.id from users.id
// ============================================

/**
 * Get the agents.id for a given users.id
 * CRITICAL: Use this when you have user context but need to write to agent_voice_profiles
 */
export async function resolveAgentIdFromUserId(userId: string): Promise<string | null> {
  if (!isValidUUID(userId)) return null

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle()

  if (error) {
    console.error("[video-voice] Error resolving agent ID:", error)
    return null
  }

  return data?.id ?? null
}

/**
 * Get agent with brokerage info from user ID
 */
export async function getAgentContext(userId: string): Promise<{
  agentId: string
  brokerageId: string
} | null> {
  if (!isValidUUID(userId)) return null

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", userId)
    .maybeSingle()

  if (error || !data) {
    console.error("[video-voice] Error getting agent context:", error)
    return null
  }

  return {
    agentId: data.id,
    brokerageId: data.brokerage_id,
  }
}

// ============================================
// INTEGRATION: Get selectable voices for video generation
// ============================================

/**
 * Get all voice options for video generation UI
 * Returns both standard voices and completed voice clones
 */
export async function getVoiceOptionsForGeneration(agentId: string) {
  // ElevenLabs premade voices ONLY (the platform's single TTS vendor — the
  // old list here was Azure Neural ids that no renderer could speak).
  const { ASSISTANT_VOICE_OPTIONS } = await import("@/lib/video/assistant-options")
  const standardVoices = ASSISTANT_VOICE_OPTIONS.map((v) => ({ id: v.voiceId, name: v.label, type: "standard", language: "English" }))

  if (!isValidUUID(agentId)) {
    return { standardVoices, voiceClones: [], defaultVoiceClone: null }
  }

  const supabase = await createClient()

  const { data: voiceClones } = await supabase
    .from("agent_voice_profiles")
    .select("id, profile_name, elevenlabs_voice_id, is_default, quality_score")
    .eq("agent_id", agentId)
    .eq("training_status", "ready")
    .not("elevenlabs_voice_id", "is", null)
    .order("is_default", { ascending: false })

  const mappedClones = (voiceClones || []).map(vc => ({
    id: vc.elevenlabs_voice_id!,
    name: vc.profile_name,
    type: "clone" as const,
    profileId: vc.id,
    isDefault: vc.is_default,
    qualityScore: vc.quality_score,
  }))

  const defaultClone = mappedClones.find(vc => vc.isDefault) ?? null

  return {
    standardVoices,
    voiceClones: mappedClones,
    defaultVoiceClone: defaultClone,
  }
}
