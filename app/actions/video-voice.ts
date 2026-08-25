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
import type {
  VoiceTrainingJobStatus,
  VoiceProfileTrainingStatus,
  SampleManifest,
  VoiceTrainingJob,
  GenerationVoiceOption,
} from "./video-voice.types"
import { VOICE_CLONE_SAMPLE_PHRASES } from "./video-voice.constants"

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** The in-progress capture for a profile: 'queued' = recorded, not yet submitted.
 *
 *  Typed as a `Pick` of the ROW CONTRACT rather than left to inference, so the
 *  two columns named in the `.select()` below are checked against
 *  `VoiceTrainingJob` (app/actions/video-voice.types.ts:65) — the declared shape
 *  of a `voice_clone_training` row. PGRST204 makes this cheap insurance: a
 *  select or an update naming a column the table does not have is refused
 *  ENTIRELY (CLAUDE.md §3), and the draft manifest this function feeds is the
 *  only place a half-finished recording session survives a page refresh. */
async function findDraftJob(
  supabase: ServerSupabase,
  profileId: string,
): Promise<Pick<VoiceTrainingJob, "id" | "sample_manifest"> | null> {
  const { data } = await supabase
    .from("voice_clone_training")
    .select("id, sample_manifest")
    .eq("voice_profile_id", profileId)
    .eq("status", "queued")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return data
}

/** Write the capture-in-progress manifest onto the draft job, creating it once. */
async function upsertDraftManifest(
  supabase: ServerSupabase,
  profileId: string,
  brokerageId: string,
  sampleManifest: SampleManifest,
) {
  const draft = await findDraftJob(supabase, profileId)

  if (draft) {
    const { error } = await supabase
      .from("voice_clone_training")
      .update({ sample_manifest: sampleManifest })
      .eq("id", draft.id)
    return error
  }

  const { error } = await supabase.from("voice_clone_training").insert({
    voice_profile_id: profileId,
    brokerage_id: brokerageId,
    provider: "elevenlabs",
    status: "queued",
    sample_manifest: sampleManifest,
  })
  return error
}

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
      voice_clone_training(id, status, sample_manifest, started_at, completed_at, error_message)
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

// getVoiceProfileById(profileId) was REMOVED (slice-3 orphan burn-down).
// The profile is a SINGLETON per agent (UNIQUE index on agent_voice_profiles
// .agent_id — see createVoiceProfile below), so getVoiceProfiles(agentId)
// already returns that one profile with its training rows embedded, scoped by
// agent. The by-id variant added no data, was scoped by nothing (a bare
// .eq("id", …) any caller could aim at another tenant's profile), and its
// voice_clone_training(*) pulled provider_response / brokerage_id into a client
// component. Nothing to merge — see docs/orphan-burndown-slice3.md.

/**
 * Open the agent's voice profile for a fresh capture.
 *
 * THE PROFILE IS A SINGLETON: agent_voice_profiles carries a UNIQUE index on
 * agent_id, so an agent has exactly one. A plain insert therefore threw a
 * duplicate-key error the second time an agent re-recorded — which is the
 * normal case, not an edge case. An agent who wants SEVERAL distinct
 * presenter voices uses the Twin Studio (agent_avatar_assets), which is the
 * surface that models more than one.
 *
 * So this is idempotent: it creates the row the first time and resets it for a
 * new capture afterwards.
 *
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

  const { data: existing } = await supabase
    .from("agent_voice_profiles")
    .select("id, training_status, elevenlabs_voice_id")
    .eq("agent_id", data.agentId)
    .maybeSingle()

  // A working clone stays usable while its replacement is being recorded.
  // Resetting the singleton to 'not_started' here would hide the agent's live
  // voice from every reader the moment they started a re-record — and if they
  // then abandoned the capture, it would stay hidden. The in-progress capture
  // lives on the draft training job, not on this row.
  const hasLiveClone = existing?.training_status === "ready" && !!existing?.elevenlabs_voice_id

  const { data: profile, error } = existing
    ? await supabase
        .from("agent_voice_profiles")
        .update(
          hasLiveClone
            ? { profile_name: data.profileName, updated_at: new Date().toISOString() }
            : {
                brokerage_id: data.brokerageId,
                profile_name: data.profileName,
                training_status: "not_started" satisfies VoiceProfileTrainingStatus,
                sample_count: 0,
                updated_at: new Date().toISOString(),
              },
        )
        .eq("id", existing.id)
        .select()
        .single()
    : await supabase
        .from("agent_voice_profiles")
        .insert({
          brokerage_id: data.brokerageId,
          agent_id: data.agentId,
          profile_name: data.profileName,
          training_status: "not_started" satisfies VoiceProfileTrainingStatus,
          sample_count: 0,
          is_default: false,
        })
        .select()
        .single()

  if (error || !profile) {
    console.error("[video-voice] Error opening voice profile:", error)
    throw error ?? new Error("Could not open the voice profile")
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

  // Never downgrade a live clone. The profile is a singleton, so an agent
  // re-recording would otherwise knock their own working voice out of every
  // reader (all of which gate on 'ready') for the whole capture — and for good
  // if they abandoned it. The replacement lands via reconciliation, not here.
  const { data: current } = await supabase
    .from("agent_voice_profiles")
    .select("training_status, elevenlabs_voice_id")
    .eq("id", profileId)
    .maybeSingle()
  const hasLiveClone = current?.training_status === "ready" && !!current?.elevenlabs_voice_id

  // Update the profile
  const { data: profile, error } = await supabase
    .from("agent_voice_profiles")
    .update({
      sample_count: recordedCount,
      // agent_voice_profiles.training_status ∈ (not_started, collecting_samples,
      // training, ready, failed). This wrote "pending", which the CHECK rejects —
      // so every mid-recording save was refused and sample_count never advanced
      // past its first value. Any recording in progress IS collecting_samples.
      training_status: (hasLiveClone
        ? "ready"
        : recordedCount > 0
          ? "collecting_samples"
          : "not_started") satisfies VoiceProfileTrainingStatus,
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

  // PERSIST THE MANIFEST, not just the count. Storing sample_count alone means
  // an interrupted capture (refresh, tab close, a call coming in) comes back
  // reading "3 of 5 recorded" with the three recordings unreachable — there is
  // nowhere else the phrase urls are written. The draft lives on
  // voice_clone_training at status 'queued', which is exactly what queued
  // means here: captured, not yet submitted to the provider.
  // startVoiceCloneTraining promotes THIS row rather than opening a second one,
  // so one attempt is one row from the first phrase to the final outcome.
  const draftError = await upsertDraftManifest(supabase, profileId, brokerageId, sampleManifest)
  if (draftError) {
    console.error("[video-voice] Error persisting sample manifest:", draftError)
    throw draftError
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

// getDefaultVoiceProfile(agentId) was REMOVED (slice-3 orphan burn-down).
// Survivor: getVoiceOptionsForGeneration(agentId).defaultVoiceClone below, which
// is the one the video-create surface actually reads — and which is STRICTER:
// it additionally requires elevenlabs_voice_id IS NOT NULL, so it cannot hand a
// renderer a profile that is training_status='ready' but has no speakable voice
// id. Nothing to merge — see docs/orphan-burndown-slice3.md.

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

  // Submit the DRAFT this capture has been accumulating into, rather than
  // opening a second row — one attempt is one row. (A profile whose capture
  // never went through updateVoiceProfileSamples still gets a row created here.)
  const draft = await findDraftJob(supabase, profileId)
  const submission = {
    sample_manifest: sampleManifest,
    started_at: new Date().toISOString(),
  }

  const { data: trainingJob, error: trainingError } = draft
    ? await supabase
        .from("voice_clone_training")
        .update(submission)
        .eq("id", draft.id)
        .select()
        .single()
    : await supabase
        .from("voice_clone_training")
        .insert({
          voice_profile_id: profileId,
          brokerage_id: brokerageId,
          provider: "elevenlabs",
          status: "queued",
          ...submission,
        })
        .select()
        .single()

  if (trainingError || !trainingJob) {
    console.error("[video-voice] Error opening training job:", trainingError)
    throw trainingError ?? new Error("Could not open the voice training job")
  }

  // Update profile status. Checked: an unchecked write here would leave the
  // profile advertising "collecting_samples" while a job runs against it.
  const { error: profileError } = await supabase
    .from("agent_voice_profiles")
    .update({
      training_status: "training" satisfies VoiceProfileTrainingStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", profileId)

  if (profileError) {
    console.error("[video-voice] Error moving profile into training:", profileError)
    throw profileError
  }

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
  status: VoiceTrainingJobStatus,
  providerResponse?: Record<string, any>,
  errorMessage?: string
): Promise<{ voiceProfileId: string; brokerageId: string | null }> {
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

  const { data: currentProfile } = await supabase
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id")
    .eq("id", job.voice_profile_id)
    .maybeSingle()

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
  // Exhaustive by type: adding a job status without deciding what it means for
  // the profile is now a compile error, not a silently-rejected write.
  const PROFILE_STATUS_FOR_JOB: Record<VoiceTrainingJobStatus, VoiceProfileTrainingStatus> = {
    queued:     "training",
    processing: "training",
    completed:  "ready",
    failed:     "failed",
  }
  // A FAILED RE-CLONE MUST NOT DESTROY THE VOICE THE AGENT ALREADY HAD. The
  // profile column answers "does a usable voice exist here", and if the previous
  // elevenlabs_voice_id survives, one does. The failure itself is recorded on
  // the job row (status + error_message), which is what the setup page reads —
  // so this is not hiding anything, it is keeping the two facts in their own
  // places. Only a first-ever clone leaves the profile at 'failed'.
  const keepsPriorClone = status === "failed" && !!currentProfile?.elevenlabs_voice_id
  const profileUpdate: Record<string, any> = {
    training_status: keepsPriorClone ? "ready" : PROFILE_STATUS_FOR_JOB[status],
    updated_at: new Date().toISOString(),
  }

  // If completed successfully, save the voice clone ID and quality score.
  // QUALITY SCORE IS ON A 0–100 SCALE throughout (column is numeric, the
  // threshold below reads 0–100, and every renderer must too).
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

  const { error: profileError } = await supabase
    .from("agent_voice_profiles")
    .update(profileUpdate)
    .eq("id", job.voice_profile_id)

  // This update carries elevenlabs_voice_id. Losing it silently is exactly how
  // a paid-for, working clone becomes invisible to every reader (they all gate
  // on training_status = 'ready'), so it must surface as a failure.
  if (profileError) {
    console.error("[video-voice] Error applying training outcome to profile:", profileError)
    throw profileError
  }

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
  revalidatePath("/dashboard/videos/create")

  return { voiceProfileId: job.voice_profile_id, brokerageId: job.brokerage_id ?? null }
}

// getTrainingJobStatus(trainingId) was REMOVED (slice-3 orphan burn-down).
// The capture surface polls by re-calling getVoiceProfiles(agentId), which
// embeds voice_clone_training(id, status, sample_manifest, started_at,
// completed_at, error_message) — every field voice-client.tsx reads. The
// removed action added only select("*") columns the client must not see
// (provider_response, brokerage_id, training_job_id) and no tenant scope.
//
// ============================================
// IDENTITY: resolve agents.id from the SESSION, not from a caller-supplied id
// ============================================
// resolveAgentIdFromUserId(userId) and a second, file-local getAgentContext(userId)
// were REMOVED here. Survivor: lib/identity/get-agent-context.ts:getAgentContext(),
// which resolves the AUTHENTICATED session (never a caller-supplied users.id) and
// carries strictly more: user_role_assignments, the users.user_type/role priority
// chain, brokerageId, and the platform-staff act-as (impersonation) seam. The two
// removed helpers were the same `agents.select(id[, brokerage_id]).eq("user_id", …)`
// query with an id handed in by the caller — i.e. an unauthenticated users.id →
// agents.id + brokerage_id oracle. The local one also SHADOWED the canonical name,
// which is why the export census never flagged it.
// See docs/orphan-burndown-slice3.md.

// ============================================
// INTEGRATION: Get selectable voices for video generation
// ============================================

/**
 * Get all voice options for video generation UI
 * Returns both standard (assistant) voices and completed voice clones.
 *
 * BOTH are usable: a premade ElevenLabs voice id and a cloned voice id go down
 * the identical TTS path, so an agent who has not recorded a clone yet is not
 * locked out of video — they present with an assistant voice and swap to their
 * own the moment the clone is ready.
 */
export async function getVoiceOptionsForGeneration(agentId: string): Promise<{
  standardVoices: GenerationVoiceOption[]
  voiceClones: GenerationVoiceOption[]
  defaultVoiceClone: GenerationVoiceOption | null
}> {
  // ElevenLabs premade voices ONLY (the platform's single TTS vendor — the
  // old list here was Azure Neural ids that no renderer could speak).
  const { ASSISTANT_VOICE_OPTIONS } = await import("@/lib/video/assistant-options")
  const standardVoices: GenerationVoiceOption[] = ASSISTANT_VOICE_OPTIONS.map((v) => ({
    id: v.voiceId,
    name: v.label,
    type: "standard",
    style: v.style,
  }))

  if (!isValidUUID(agentId)) {
    return { standardVoices, voiceClones: [], defaultVoiceClone: null }
  }

  const supabase = await createClient()

  const { data: voiceClones, error: clonesError } = await supabase
    .from("agent_voice_profiles")
    .select("id, profile_name, elevenlabs_voice_id, is_default, quality_score")
    .eq("agent_id", agentId)
    .eq("training_status", "ready")
    .not("elevenlabs_voice_id", "is", null)
    .order("is_default", { ascending: false })

  if (clonesError) {
    // Say nothing rather than pretend the agent has no clones — the caller
    // renders "record your voice" on an empty list, which would be a lie.
    console.error("[video-voice] Error loading voice clones for generation:", clonesError)
  }

  const mappedClones: GenerationVoiceOption[] = (voiceClones || []).map(vc => ({
    id: vc.elevenlabs_voice_id!,
    name: vc.profile_name,
    type: "clone" as const,
    profileId: vc.id,
    isDefault: vc.is_default ?? false,
    qualityScore: vc.quality_score,
  }))

  const defaultClone = mappedClones.find(vc => vc.isDefault) ?? null

  return {
    standardVoices,
    voiceClones: mappedClones,
    defaultVoiceClone: defaultClone,
  }
}
