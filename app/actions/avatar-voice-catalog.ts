"use server"

/**
 * AVATAR / VOICE CATALOG + PHOTO VIDEO (platform-locked engine: D-ID + ElevenLabs).
 *
 * BUSINESS RULE: the avatar/explainer-video engine is D-ID + ElevenLabs ONLY —
 * HeyGen is NOT used and there is no HeyGen branch anywhere in this file.
 *
 * This file was app/actions/heygen-avatars.ts, and its exports were named
 * getHeyGenAvatars / listHeygenVoices / HeyGenAvatar / HeyGenVoice long after
 * the last HeyGen call was removed. The names were kept "for backward-compat
 * with existing importers" — but a name is not a compatibility surface, it is
 * what the next reader believes. getHeyGenAvatars reads agent_avatar_assets
 * (D-ID) and listHeygenVoices calls api.elevenlabs.io; anyone auditing which
 * vendors this platform pays, or grepping for HeyGen before an integration
 * decision, would have found a live-looking HeyGen surface that does not exist.
 * Renamed after what each one actually calls. Behaviour is unchanged — this was
 * a rename and nothing else.
 */
import { createClient } from "@/lib/supabase/server"

export interface AvatarOption {
  avatar_id: string
  avatar_name: string
  preview_image_url: string | null
  gender: string | null
  is_public: boolean
}

/**
 * Render a talking-head video from a still photo. Delegates to D-ID photo mode
 * (the /talks endpoint animates the headshot; voice is ElevenLabs TTS).
 */
export async function createTalkingPhotoVideo(params: {
  photoUrl: string
  script: string
  voiceId: string
}): Promise<{ success: boolean; videoId?: string; error?: string; requiresConfiguration?: boolean }> {
  const didApiKey = process.env.DID_API_KEY
  const elApiKey = process.env.ELEVENLABS_API_KEY
  if (!didApiKey || !elApiKey) {
    return {
      success: false,
      requiresConfiguration: true,
      error: "Video provider (D-ID + ElevenLabs) not configured. Add DID_API_KEY and ELEVENLABS_API_KEY to environment variables.",
    }
  }

  // Resolve brokerage scope for the vendor budget gate inside lib/did.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  let brokerageId = ""
  if (user?.id) {
    const { data: userRow } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
    brokerageId = userRow?.brokerage_id ?? ""
  }

  const { generateVideo } = await import("@/lib/did")
  const result = await generateVideo({
    script: params.script,
    voiceId: params.voiceId && params.voiceId !== "default" ? params.voiceId : undefined,
    avatarImageUrl: params.photoUrl,
    brokerageId,
  })
  if (result.status === "error") {
    return { success: false, error: result.note ?? "D-ID render failed" }
  }
  return { success: true, videoId: result.videoId }
}

export interface VoiceOption {
  voice_id: string
  name: string
  language: string
  gender: string | null
}

/**
 * List the ElevenLabs voices available to the platform. HeyGen voice listing is
 * removed — the only voice engine is ElevenLabs.
 */
export async function listElevenLabsVoices(): Promise<{ success: boolean; voices: VoiceOption[] }> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) return { success: false, voices: [] }
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<{ voices?: any[] }>({
    connector: "elevenlabs",
    baseUrl: "https://api.elevenlabs.io",
    path: "/v1/voices",
    method: "GET",
    auth: { style: "header", name: "xi-api-key", value: apiKey },
  })
  if (!res.ok || !res.data) return { success: false, voices: [] }
  const voices: VoiceOption[] = (res.data.voices ?? []).map((v: any) => ({
    voice_id: v.voice_id,
    name: v.name ?? v.voice_id,
    language: v.labels?.language ?? v.fine_tuning?.language ?? "en",
    gender: v.labels?.gender ?? null,
  }))
  return { success: true, voices }
}

/**
 * List the D-ID avatars (agent_avatar_assets) available to the current agent.
 * Returns ready avatars only, mapped into the legacy AvatarOption shape so
 * existing UI consumers keep working without a structural change.
 */
export async function getDidAvatars(): Promise<{ success: boolean; avatars: AvatarOption[] }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) return { success: false, avatars: [] }

  const { data: agentRow } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()
  if (!agentRow?.id) return { success: true, avatars: [] }

  const { data: assets } = await supabase
    .from("agent_avatar_assets")
    .select("did_avatar_id, label, source_url, source_type, status")
    .eq("agent_id", agentRow.id)
    .eq("status", "ready")

  const avatars: AvatarOption[] = (assets ?? [])
    .filter((a: any) => a.did_avatar_id)
    .map((a: any) => ({
      avatar_id: a.did_avatar_id,
      avatar_name: a.label ?? "My Avatar",
      preview_image_url: a.source_type === "photo" ? (a.source_url ?? null) : null,
      gender: null,
      is_public: false,
    }))
  return { success: true, avatars }
}
