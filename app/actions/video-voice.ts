"use server"

// ============================================
// Layer 8.3 — Voice Clone Engine Actions
// CANONICAL TABLE: public.agent_voice_profiles, public.voice_clone_training
// ============================================

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

// ─── WHAT IS NOT HERE ANY MORE ────────────────────────────────────────────────
//
// startVoiceCloneTraining / updateTrainingJobStatus / getTrainingJobStatus /
// updateVoiceProfileSamples were REMOVED. They implemented an ASYNCHRONOUS,
// phrase-by-phrase training pipeline: record N scripted phrases into a sample
// manifest, open a voice_clone_training job, then poll or webhook it to
// completion. Nothing in this product does that. The voice engine is
// ElevenLabs Instant Voice Clone, and POST /api/elevenlabs/voice-clone →
// /voices/add is SYNCHRONOUS — it returns the voice_id on the same request,
// so there is no job to open, poll or complete. The evidence: the
// voice_clone_training table had no writer and no reader outside those four
// functions, and video-voice.constants.ts (VOICE_CLONE_SAMPLE_PHRASES) and
// video-voice.types.ts (SampleManifest / UploadedSample / VoiceTrainingJob /
// VoiceTrainingStatus) had no importer outside this file. The whole limb was
// self-referential.
//
// resolveAgentIdFromUserId was REMOVED — it was a second, private copy of the
// canonical resolveAgentId() (lib/kernel/agent-identity.ts), which has ~130
// callers. One resolver, one id space.
//
// getVoiceProfileById was REMOVED — a single-row read of the same rows, with
// the same joins, that getVoiceProfiles() below already returns to the page.
//
// getVoiceOptionsForGeneration was REMOVED. It offered ElevenLabs PREMADE
// voices alongside the agent's clones, but the video wizard deliberately gates
// on a personal clone ("Voice clone not set up. Visit Settings → Voice &
// Avatar…") and reads agent_voice_profiles directly to honour that gate.
// Offering a generic voice would have quietly defeated it.

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
