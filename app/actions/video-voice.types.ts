// ============================================
// Layer 8.3 — Voice Clone Engine Types
// ============================================

export type VoiceTrainingStatus = 
  | "pending"
  | "queued"
  | "collecting_samples"
  | "processing"
  | "completed"
  | "failed"

export interface VoiceProfile {
  id: string
  brokerage_id: string
  agent_id: string
  profile_name: string
  training_status: VoiceTrainingStatus
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
  status: VoiceTrainingStatus
  sample_manifest: SampleManifest | null
  provider_response: Record<string, any> | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface UploadedSample {
  phrase: string
  audioUrl: string
  durationSeconds: number
}
