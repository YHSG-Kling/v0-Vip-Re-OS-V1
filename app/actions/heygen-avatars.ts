"use server"

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
  try {
    const res = await fetch("https://api.heygen.com/v2/video/generate", {
      method: "POST",
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        video_inputs: [{
          character: {
            type: "talking_photo",
            talking_photo_url: params.photoUrl,
          },
          voice: {
            type: "text",
            input_text: params.script,
            voice_id: params.voiceId || "default",
          },
        }],
        dimension: { width: 1280, height: 720 },
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error?.message ?? "HeyGen Talking Photo error")
    return { success: true, videoId: data.data?.video_id }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
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
  try {
    const res = await fetch("https://api.heygen.com/v2/voices", {
      headers: { "X-Api-Key": apiKey },
      next: { revalidate: 3600 },
    })
    if (!res.ok) return { success: false, voices: [] }
    const data = await res.json()
    const voices: HeyGenVoice[] = (data?.data?.voices ?? []).map((v: any) => ({
      voice_id: v.voice_id,
      name: v.name ?? v.voice_id,
      language: v.language ?? "en",
      gender: v.gender ?? null,
    }))
    return { success: true, voices }
  } catch {
    return { success: false, voices: [] }
  }
}

export async function getHeyGenAvatars(): Promise<{ success: boolean; avatars: HeyGenAvatar[] }> {
  const apiKey = process.env.HEYGEN_API_KEY
  if (!apiKey) return { success: false, avatars: [] }

  try {
    const res = await fetch("https://api.heygen.com/v2/avatars", {
      headers: { "X-Api-Key": apiKey },
      next: { revalidate: 3600 },
    })
    if (!res.ok) return { success: false, avatars: [] }

    const data = await res.json()
    const avatars: HeyGenAvatar[] = (data?.data?.avatars ?? []).map((a: any) => ({
      avatar_id: a.avatar_id,
      avatar_name: a.avatar_name ?? a.avatar_id,
      preview_image_url: a.preview_image_url ?? null,
      gender: a.gender ?? null,
      is_public: a.is_public ?? true,
    }))
    return { success: true, avatars }
  } catch {
    return { success: false, avatars: [] }
  }
}
