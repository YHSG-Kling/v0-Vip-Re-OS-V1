"use server"

export interface HeyGenAvatar {
  avatar_id: string
  avatar_name: string
  preview_image_url: string | null
  gender: string | null
  is_public: boolean
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
