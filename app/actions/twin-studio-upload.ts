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

import { resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { createServiceClient } from "@/lib/supabase/service"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { checkUpload } from "@/lib/storage/file-limits"
// THE ONE bucket-creation helper (§6) — see the tombstone below for the
// module-local copy this replaced and why the survivor is the more complete one.
import { ensureBucket } from "@/lib/storage/buckets"

const AVATAR_BUCKET = "twin-avatars"
const VOICE_BUCKET = "twin-voice-samples"

// ═══════════════════════════════════════════════════════════════════════════
// TOMBSTONE — the module-local `ensureBucket(name)` that stood here
// ═══════════════════════════════════════════════════════════════════════════
// DELETED as a DUPLICATE (§1.1, 2026-09-04). Its own comment already conceded
// half the defect — "this was a bare `50 * 1024 * 1024` here AND in
// lib/storage/buckets.ts#ensureBucket, so a change to either would have
// silently missed the other" — and fixed only the CONSTANT, leaving two
// functions.
//
// ── THE SURVIVOR, AT file:symbol ──────────────────────────────────────────
//     lib/storage/buckets.ts  ensureBucket
//
// It is STRICTLY MORE COMPLETE, and the difference is the one that matters:
// this copy hardcoded `public: true`, while the survivor defaults visibility to
// the bucket's CLASSIFICATION (lib/storage/document-buckets.ts) and only takes
// `public` when a caller writes it down. The survivor's own header explains
// why that default changed — "commission disclosures and signed contractor
// agreements would have been born world-readable, permanently, because nobody
// passed a flag."
//
// BEHAVIOUR IS UNCHANGED FOR THESE TWO BUCKETS, which is why this is a safe
// deletion rather than a reclassification: `twin-avatars` and
// `twin-voice-samples` are both on PUBLIC_MEDIA_BUCKETS, so
// `!isDocumentClassBucket(name)` is `true` for each and the survivor creates
// them public — the same answer, reached by consulting the roster instead of
// by an argument nobody could see. If the owner resolves the UNRESOLVED note on
// `twin-voice-samples` ("a voice print is closer to biometric than to
// marketing"), moving it in the roster now moves this call site with it; under
// the deleted copy it would have kept creating the bucket public forever.
//
// The `fileSizeLimit` default is unchanged — the survivor reads the same
// BUCKET_CREATION_DEFAULT_LIMIT_BYTES, which is still the real ceiling for
// these two buckets because neither exists live (measured 2026-09-04: twelve
// buckets, neither of them among them).

/**
 * NOT EXPORTED, deliberately: in a `"use server"` file every export is a public
 * HTTP endpoint (CLAUDE.md §4), so a "private helper" that is exported is not
 * private. This one is module-local.
 *
 * THE SIZE GATE FOR THE THREE ACTIONS BELOW, none of which had one. Each takes
 * the file as a base64 STRING in a Server Action argument, which is the shape
 * most exposed to the transport ceiling: Vercel caps a function request body at
 * 4.5 MB, base64 is a third larger than the bytes it carries, and next.config.ts
 * raising serverActions.bodySizeLimit to 8mb cannot lift a cap enforced in front
 * of the framework. So the real ceiling is ~3.4 MB of actual file, and the twin
 * wizard's own UI was telling agents 10 MB (photo) and 50 MB (video).
 *
 * The decoded length is COMPUTED from the string rather than by allocating the
 * Buffer — refusing after materialising the payload would still have spent the
 * memory the limit exists to protect.
 */
function gateBase64Upload(bucket: string, base64: string, mimeType: string) {
  const raw = base64.trim()
  if (!raw) return { ok: false as const, error: "No file data was received." }
  const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0
  const decodedBytes = Math.max(0, Math.floor(raw.length / 4) * 3 - padding)
  const gate = checkUpload({
    bucket,
    transport: "server_action_base64",
    bytes: decodedBytes,
    contentType: mimeType,
  })
  return gate.ok ? { ok: true as const } : { ok: false as const, error: gate.reason }
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
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.agentId) return { ok: false, error: "Unauthorized" }

  const expectedPrefix = params.kind === "photo" ? "image/" : "video/"
  if (!params.mimeType.startsWith(expectedPrefix)) {
    return { ok: false, error: `Wrong file type for ${params.kind}` }
  }

  const gate = gateBase64Upload(AVATAR_BUCKET, params.base64, params.mimeType)
  if (!gate.ok) return { ok: false, error: gate.error }

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
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.agentId) return { ok: false, error: "Unauthorized" }

  if (!params.mimeType.startsWith("audio/")) {
    return { ok: false, error: "File must be audio" }
  }

  const gate = gateBase64Upload(VOICE_BUCKET, params.base64, params.mimeType)
  if (!gate.ok) return { ok: false, error: gate.error }

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
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  if (!isAdminOrBroker({ user_type: ctx.userType ?? "" })) {
    return { ok: false, error: "Only broker / admin can record the ISA voice" }
  }
  if (!params.mimeType.startsWith("audio/")) {
    return { ok: false, error: "File must be audio" }
  }

  const gate = gateBase64Upload(VOICE_BUCKET, params.base64, params.mimeType)
  if (!gate.ok) return { ok: false, error: gate.error }

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
