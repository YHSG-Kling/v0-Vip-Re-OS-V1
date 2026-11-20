/**
 * lib/voice/voice-clone-training.ts — the training-job OUTCOME writer (wave 155, lane 155S1).
 *
 * MOVED HERE FROM app/actions/video-voice.ts, WHERE IT WAS A PUBLIC ENDPOINT. In a "use server" file every export is a
 * public HTTP endpoint (CLAUDE.md §4), and updateTrainingJobStatus took a training id and a provider response from its
 * ARGUMENTS with no session: anyone could mark any tenant's voice-clone job 'completed' and write an arbitrary
 * elevenlabs_voice_id onto that agent's profile through the service client — the voice every reader then speaks with.
 *
 * This is a PLAIN server module ("server-only"), so it is not reachable from a browser. Its one caller is the voice-clone
 * route (app/api/elevenlabs/voice-clone/route.ts), which authenticates the SESSION first (requireAuth) and passes that
 * session's tenant and the profile the request names as `scope`. The job is read PINNED to both — another tenant's job, or
 * a job of a different profile, answers "Training job not found" and nothing is written — and both updates are pinned to the
 * same tenant and COUNTED: an update that matched nothing is not a success (§3).
 *
 * Everything else is byte-for-byte the moved body: the two status vocabularies, the keep-the-prior-clone rule, the quality
 * threshold, the lifecycle echoes and VOICE_CLONE_READY.
 */
import "server-only"
import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { KernelEvent } from "@/lib/kernel/events"
import { isValidUUID } from "@/lib/validations"
import type { VoiceTrainingJobStatus, VoiceProfileTrainingStatus } from "@/app/actions/video-voice.types"

/** The session-verified scope the caller already proved: the tenant from the session, the profile the request names. */
export interface VoiceTrainingScope {
  brokerageId: string
  profileId: string
}

/**
 * Update training job status from the provider outcome (the clone route's synchronous result).
 */
export async function updateTrainingJobStatus(
  trainingId: string,
  status: VoiceTrainingJobStatus,
  providerResponse: Record<string, any> | undefined,
  errorMessage: string | undefined,
  scope: VoiceTrainingScope,
): Promise<{ voiceProfileId: string; brokerageId: string | null }> {
  if (!isValidUUID(trainingId)) {
    throw new Error("Invalid training ID")
  }
  if (!scope?.brokerageId || !isValidUUID(scope.brokerageId) || !scope.profileId || !isValidUUID(scope.profileId)) {
    throw new Error("Training job not found")
  }

  const supabase = createServiceClient()

  // Get the training job to find profile and brokerage — pinned to the caller's tenant AND the profile it named.
  const { data: job, error: jobErr } = await supabase
    .from("voice_clone_training")
    .select("voice_profile_id, brokerage_id")
    .eq("id", trainingId)
    .eq("brokerage_id", scope.brokerageId)
    .eq("voice_profile_id", scope.profileId)
    .maybeSingle()

  if (jobErr) {
    throw new Error(`Training job could not be read: ${jobErr.message}`)
  }
  if (!job) {
    throw new Error("Training job not found")
  }

  const { data: currentProfile } = await supabase
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id")
    .eq("id", job.voice_profile_id)
    .eq("brokerage_id", scope.brokerageId)
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

  // Update training job (tenant-pinned, counted — §3).
  const { data: jobUpdated, error: updateError } = await supabase
    .from("voice_clone_training")
    .update(updateData)
    .eq("id", trainingId)
    .eq("brokerage_id", scope.brokerageId)
    .select("id")

  if (updateError) {
    console.error("[voice-clone-training] Error updating training job:", updateError)
    throw updateError
  }
  if ((jobUpdated ?? []).length !== 1) {
    throw new Error("Training job not found")
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
        console.warn(`[voice-clone-training] Voice clone quality below threshold: ${qualityScore}%`)
      }
    }
  }

  const { data: profileUpdated, error: profileError } = await supabase
    .from("agent_voice_profiles")
    .update(profileUpdate)
    .eq("id", job.voice_profile_id)
    .eq("brokerage_id", scope.brokerageId)
    .select("id")

  // This update carries elevenlabs_voice_id. Losing it silently is exactly how
  // a paid-for, working clone becomes invisible to every reader (they all gate
  // on training_status = 'ready'), so it must surface as a failure.
  if (profileError) {
    console.error("[voice-clone-training] Error applying training outcome to profile:", profileError)
    throw profileError
  }
  if ((profileUpdated ?? []).length !== 1) {
    throw new Error("The voice profile for this training job could not be updated")
  }

  // Write lifecycle event
  const eventType = status === "completed"
    ? KernelEvent.VOICE_CLONE_TRAINING_COMPLETED
    : status === "failed"
      ? KernelEvent.VOICE_CLONE_TRAINING_FAILED
      : KernelEvent.VOICE_CLONE_TRAINING_STARTED

  await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
    entityType: "voice_training",
    entityId: trainingId,
    brokerageId: job.brokerage_id,
    event: eventType,
    metadata: {
      status,
      profile_id: job.voice_profile_id,
      quality_score: providerResponse?.quality_score ?? null,
      error_message: errorMessage ?? null,
    },
    auditOnly: true,
  }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

  // Fire VOICE_CLONE_READY if completed with acceptable quality
  if (status === "completed") {
    const qualityScore = providerResponse?.quality_score ?? 100
    if (qualityScore >= 70) {
      await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
        entityType: "voice_profile",
        entityId: job.voice_profile_id,
        brokerageId: job.brokerage_id,
        event: KernelEvent.VOICE_CLONE_READY,
        // Wave 102C: ONE emit (row + fan-out). The reactor forwards this metadata as the manager-signal
        // payload (was {} from the bare fan-out) — a superset read by named keys, so harmless.
        metadata: {
          training_id: trainingId,
          voice_id: providerResponse?.voice_id,
          quality_score: qualityScore,
        },
        agentUserId: null,
      }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })
    }
  }

  revalidatePath("/dashboard/videos/voice")
  revalidatePath("/dashboard/videos/create")

  return { voiceProfileId: job.voice_profile_id, brokerageId: job.brokerage_id ?? null }
}
