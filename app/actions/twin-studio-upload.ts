"use server"

/**
 * app/actions/twin-studio-upload.ts
 *
 * Handles file uploads for the Twin Studio wizard. Two buckets:
 *   - twin-avatars     photo or video clips that become the look
 *   - twin-voice-samples  audio recordings that become the cloned voice
 *
 * Each uploader returns a public URL the existing endpoints
 * (/api/did/create-avatar, /api/elevenlabs/voice-clone) already accept.
 */

import { resolveWriteContext } from "@/lib/kernel/identity"
import { createServiceClient } from "@/lib/supabase/service"

const AVATAR_BUCKET = "twin-avatars"
const VOICE_BUCKET = "twin-voice-samples"

async function ensureBucket(name: string) {
  const supabase = createServiceClient()
  const { data: list } = await supabase.storage.listBuckets()
  const exists = list?.some((b) => b.name === name)
  if (!exists) {
    await supabase.storage.createBucket(name, {
      public: true,
      fileSizeLimit: 50 * 1024 * 1024, // 50 MB ceiling per upload
    })
  }
}

function extFromMime(mime: string, fallback: string): string {
  const m: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-m4a": "m4a",
    "audio/mp4": "m4a",
  }
  return m[mime] ?? fallback
}

export async function uploadTwinAvatar(params: {
  base64: string
  mimeType: string
  /** "photo" or "video" — used to validate the mime + name the file. */
  kind: "photo" | "video"
}): Promise<{ ok: boolean; url?: string; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.agentId) return { ok: false, error: "Unauthorized" }

  const expectedPrefix = params.kind === "photo" ? "image/" : "video/"
  if (!params.mimeType.startsWith(expectedPrefix)) {
    return { ok: false, error: `Wrong file type for ${params.kind}` }
  }

  await ensureBucket(AVATAR_BUCKET)

  const supabase = createServiceClient()
  const ext = extFromMime(params.mimeType, params.kind === "photo" ? "jpg" : "mp4")
  const path = `${ctx.brokerageId}/${ctx.agentId}/${crypto.randomUUID()}.${ext}`
  const buffer = Buffer.from(params.base64, "base64")

  const { error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, buffer, { contentType: params.mimeType, upsert: false })
  if (error) return { ok: false, error: error.message }

  const { data: pub } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path)
  return { ok: true, url: pub.publicUrl }
}

export async function uploadTwinVoiceSample(params: {
  base64: string
  mimeType: string
}): Promise<{ ok: boolean; url?: string; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.agentId) return { ok: false, error: "Unauthorized" }

  if (!params.mimeType.startsWith("audio/")) {
    return { ok: false, error: "File must be audio" }
  }

  await ensureBucket(VOICE_BUCKET)

  const supabase = createServiceClient()
  const ext = extFromMime(params.mimeType, "mp3")
  const path = `${ctx.brokerageId}/${ctx.agentId}/${crypto.randomUUID()}.${ext}`
  const buffer = Buffer.from(params.base64, "base64")

  const { error } = await supabase.storage
    .from(VOICE_BUCKET)
    .upload(path, buffer, { contentType: params.mimeType, upsert: false })
  if (error) return { ok: false, error: error.message }

  const { data: pub } = supabase.storage.from(VOICE_BUCKET).getPublicUrl(path)
  return { ok: true, url: pub.publicUrl }
}

/**
 * Brokerage-scoped voice sample upload — for the ISA voice clone, which is a
 * BROKERAGE-wide setting owned by broker/admin. Unlike uploadTwinVoiceSample
 * (per-agent, requires an agents row), this requires only the brokerage context
 * + a broker/admin role, so a pure admin with no agents row can still record the
 * ISA voice. Stored under the same voice bucket at <brokerageId>/isa/<uuid>.
 */
export async function uploadBrokerageVoiceSample(params: {
  base64: string
  mimeType: string
}): Promise<{ ok: boolean; url?: string; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  if (!["broker", "broker_admin", "admin", "superadmin"].includes(ctx.userType ?? "")) {
    return { ok: false, error: "Only broker / admin can record the ISA voice" }
  }
  if (!params.mimeType.startsWith("audio/")) {
    return { ok: false, error: "File must be audio" }
  }

  await ensureBucket(VOICE_BUCKET)

  const supabase = createServiceClient()
  const ext = extFromMime(params.mimeType, "mp3")
  const path = `${ctx.brokerageId}/isa/${crypto.randomUUID()}.${ext}`
  const buffer = Buffer.from(params.base64, "base64")

  const { error } = await supabase.storage
    .from(VOICE_BUCKET)
    .upload(path, buffer, { contentType: params.mimeType, upsert: false })
  if (error) return { ok: false, error: error.message }

  const { data: pub } = supabase.storage.from(VOICE_BUCKET).getPublicUrl(path)
  return { ok: true, url: pub.publicUrl }
}
