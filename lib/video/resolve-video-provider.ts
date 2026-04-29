export type VideoProvider = "did" | "heygen" | "slideshow"

export interface AgentVideoProfile {
  preferred_avatar_provider?: string | null
  elevenlabs_voice_id?: string | null
  did_photo_url?: string | null
  did_video_url?: string | null
  heygen_voice_clone_id?: string | null
}

const LISTING_VIDEO_TYPES = ["listing_property", "property_tour", "listing_voiceover"]

export function resolveVideoProvider(videoType: string, agentProfile: AgentVideoProfile): VideoProvider {
  if (LISTING_VIDEO_TYPES.includes(videoType)) return "slideshow"
  if (agentProfile.preferred_avatar_provider === "heygen") return "heygen"
  return "did"
}

export function resolveVoiceConfig(
  provider: VideoProvider,
  agentProfile: AgentVideoProfile
): { voiceId: string | null; provider: "elevenlabs" | "heygen" } {
  if (provider === "heygen" && agentProfile.heygen_voice_clone_id) {
    return { voiceId: agentProfile.heygen_voice_clone_id, provider: "heygen" }
  }
  return { voiceId: agentProfile.elevenlabs_voice_id ?? null, provider: "elevenlabs" }
}
