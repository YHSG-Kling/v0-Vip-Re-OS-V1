"use server"

// HeyGen is a PLATFORM-owned connector (one HEYGEN_API_KEY; subscribers' avatars/voices ride as
// request params). All egress goes through the single connector-gateway. Auth = X-Api-Key header.
import { callConnector } from "@/lib/agentic-os/connector-gateway"

export interface HeyGenAvatar {
  avatar_id: string
  avatar_name: string
  preview_image_url: string | null
  gender: string | null
  is_public: boolean
}

export async function createTalkingPhotoVideo(params: {
  photoUrl: string
  script: string
  voiceId: string
}): Promise<{ success: boolean; videoId?: string; error?: string; requiresConfiguration?: boolean }> {
  const apiKey = process.env.HEYGEN_API_KEY
  if (!apiKey) {
    return { success: false, requiresConfiguration: true, error: "HeyGen API key not configured. Add HEYGEN_API_KEY to environment variables." }
  }
  const res = await callConnector<{ data?: { video_id?: string } }>({
    connector: "heygen",
    baseUrl: "https://api.heygen.com",
    path: "v2/video/generate",
    method: "POST",
    auth: { style: "header", name: "X-Api-Key", value: apiKey },
    body: {
      video_inputs: [{
        character: { type: "talking_photo", talking_photo_url: params.photoUrl },
        voice: { type: "text", input_text: params.script, voice_id: params.voiceId || "default" },
      }],
      dimension: { width: 1280, height: 720 },
    },
  })
  if (!res.ok) return { success: false, error: res.error ?? "HeyGen Talking Photo error" }
  return { success: true, videoId: res.data?.data?.video_id }
}

export interface HeyGenVoice {
  voice_id: string
  name: string
  language: string
  gender: string | null
}

export async function listHeygenVoices(): Promise<{ success: boolean; voices: HeyGenVoice[] }> {
  const apiKey = process.env.HEYGEN_API_KEY
  if (!apiKey) return { success: false, voices: [] }
  const res = await callConnector<{ data?: { voices?: any[] } }>({
    connector: "heygen",
    baseUrl: "https://api.heygen.com",
    path: "v2/voices",
    method: "GET",
    auth: { style: "header", name: "X-Api-Key", value: apiKey },
  })
  if (!res.ok || !res.data) return { success: false, voices: [] }
  const voices: HeyGenVoice[] = (res.data?.data?.voices ?? []).map((v: any) => ({
    voice_id: v.voice_id,
    name: v.name ?? v.voice_id,
    language: v.language ?? "en",
    gender: v.gender ?? null,
  }))
  return { success: true, voices }
}

export async function getHeyGenAvatars(): Promise<{ success: boolean; avatars: HeyGenAvatar[] }> {
  const apiKey = process.env.HEYGEN_API_KEY
  if (!apiKey) return { success: false, avatars: [] }

  const res = await callConnector<{ data?: { avatars?: any[] } }>({
    connector: "heygen",
    baseUrl: "https://api.heygen.com",
    path: "v2/avatars",
    method: "GET",
    auth: { style: "header", name: "X-Api-Key", value: apiKey },
  })
  if (!res.ok || !res.data) return { success: false, avatars: [] }
  const avatars: HeyGenAvatar[] = (res.data?.data?.avatars ?? []).map((a: any) => ({
    avatar_id: a.avatar_id,
    avatar_name: a.avatar_name ?? a.avatar_id,
    preview_image_url: a.preview_image_url ?? null,
    gender: a.gender ?? null,
    is_public: a.is_public ?? true,
  }))
  return { success: true, avatars }
}
