// ============================================
// Layer 8.3 — Voice Clone Engine Types
// ============================================

// TWO VOCABULARIES, TWO TYPES. These are separate live CHECK constraints and
// mixing them is how a clone gets billed and then thrown away:
//
//   voice_clone_training.status        ∈ queued | processing | completed | failed
//   agent_voice_profiles.training_status ∈ not_started | collecting_samples |
//                                          training | ready | failed
//
// A single union spanning both is satisfiable by a value the target column
// rejects, and PostgREST answers a rejected write with a resolved promise —
// so the failure is silent. Keep them apart so `tsc` catches the swap.

/** Storable in voice_clone_training.status. */
export type VoiceTrainingJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"

/** Storable in agent_voice_profiles.training_status. */
export type VoiceProfileTrainingStatus =
  | "not_started"
  | "collecting_samples"
  | "training"
  | "ready"
  | "failed"

export interface VoiceProfile {
  id: string
  brokerage_id: string
  agent_id: string
  profile_name: string
  training_status: VoiceProfileTrainingStatus
  sample_count: number
  elevenlabs_voice_id: string | null
  quality_score: number | null
  is_default: boolean
  created_at: string
  updated_at: string
  voice_clone_training?: Array<{ sample_manifest: SampleManifest | null }>
}

export interface SamplePhrase {
  phrase_id: string
  phrase_text: string
  audio_url?: string
  duration_seconds?: number
  recorded_at?: string
  status: "pending" | "recorded" | "validated" | "rejected"
}

export interface SampleManifest {
  total_samples?: number
  samples?: Array<{
    phrase: string
    url: string
    duration_seconds: number
  }>
  phrases?: SamplePhrase[]
}

export interface VoiceTrainingJob {
  id: string
  voice_profile_id: string
  brokerage_id: string
  training_job_id: string | null
  provider: string
  status: VoiceTrainingJobStatus
  sample_manifest: SampleManifest | null
  provider_response: Record<string, any> | null
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

/** A voice the video wizard can present with — a clone or a premade assistant
 *  voice. Both are ElevenLabs voice ids and go down the identical TTS path. */
export interface GenerationVoiceOption {
  /** The ElevenLabs voice id the renderer speaks with. */
  id: string
  name: string
  type: "standard" | "clone"
  /** Premade only: how the persona reads, shown in the picker. */
  style?: string
  /** Clone only. */
  profileId?: string
  isDefault?: boolean
  /** Clone only. 0–100, or null when the provider gave no score. */
  qualityScore?: number | null
}

// TOMBSTONE: `UploadedSample` — DELETED as a third spelling of one shape.
// SURVIVOR: `SamplePhrase`, app/actions/video-voice.types.ts:46.
//
// It declared `{ phrase, audioUrl, durationSeconds }` in camelCase; the shape
// that is actually written and read is `SamplePhrase`
// (`phrase_text` / `audio_url` / `duration_seconds`), which is what
// `SampleManifest.phrases` holds and what updateVoiceProfileSamples counts and
// persists. The survivor carries everything this had plus the two fields the
// capture flow depends on — `phrase_id` and `status` ("pending" | "recorded" |
// "validated" | "rejected"), the field the recorded-count filter reads.
//
// NOTHING WAS LOST. This interface had no writer, no reader and no importer
// anywhere in the tree — its only mention was a dead `import type` in
// app/actions/video-voice.ts. A camelCase twin of a snake_case row shape is
// exactly the two-vocabularies defect CLAUDE.md §6 names: a scorer, or a
// person, matching one spelling cannot see the other.
