"use server"

/**
 * AVATAR / VOICE LISTING + PHOTO VIDEO (platform-locked engine: D-ID + ElevenLabs).
 *
 * BUSINESS RULE: the avatar/explainer-video engine is D-ID + ElevenLabs ONLY —
 * HeyGen is NOT used. The function names below are retained for backward-compat
 * with existing importers, but every path now resolves D-ID avatars
 * (agent_avatar_assets) and ElevenLabs voices, and renders via D-ID.
 */
import { createClient } from "@/lib/supabase/server"

export interface HeyGenAvatar {
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

export interface HeyGenVoice {
  voice_id: string
  name: string
  language: string
  gender: string | null
}

/**
 * List the ElevenLabs voices available to the platform. HeyGen voice listing is
 * removed — the only voice engine is ElevenLabs.
 */
export async function listHeygenVoices(): Promise<{ success: boolean; voices: HeyGenVoice[] }> {
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
  const voices: HeyGenVoice[] = (res.data.voices ?? []).map((v: any) => ({
    voice_id: v.voice_id,
    name: v.name ?? v.voice_id,
    language: v.labels?.language ?? v.fine_tuning?.language ?? "en",
    gender: v.labels?.gender ?? null,
  }))
  return { success: true, voices }
}

/**
 * List the D-ID avatars (agent_avatar_assets) available to the current agent.
 * Returns ready avatars only, mapped into the legacy HeyGenAvatar shape so
 * existing UI consumers keep working without a structural change.
 */
export async function getHeyGenAvatars(): Promise<{ success: boolean; avatars: HeyGenAvatar[] }> {
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

  const avatars: HeyGenAvatar[] = (assets ?? [])
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
