// lib/did/avatar-completion.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE PLACE THAT DECIDES WHAT A FINISHED D-ID AVATAR MEANS.
//
// Two things now learn that an avatar finished: the poll cron (every 3 minutes,
// asks D-ID) and the webhook (D-ID tells us, in seconds). If each carried its
// own copy of "on done, re-host the image, mirror it onto the profile, notify
// the agent, and check creation_notes for a silently-failed voice clone", they
// would drift apart the first time one of them was fixed — which is the exact
// defect class this OS keeps producing. So the completion logic lives HERE and
// both callers hand it the same payload.
//
// IDEMPOTENT BY CONSTRUCTION. A webhook can be redelivered, and the cron can
// race the webhook on the same asset — D-ID retries on non-2xx and there is no
// delivery-once guarantee. So this re-reads the row and REFUSES to act on one
// that already reached a terminal state. Without that check a replayed
// completion re-downloads the avatar and inserts a second "Avatar Ready"
// notification, and the agent learns to distrust the notification bell.
//
// The status vocabulary this writes is the column's CHECK constraint:
// pending | processing | ready | failed. Nothing else is writable.

import { classifyDidError } from "./contract"

/** The subset of a D-ID scene-avatar payload this needs. Shape is identical on
 *  the GET /scenes/avatars/{id} response and the webhook body. */
export interface DidAvatarPayload {
  status?: string | null
  image_url?: string | null
  thumbnail_url?: string | null
  preview_url?: string | null
  error?: unknown
  creation_notes?: {
    is_clone_voice_failed?: boolean
    worker_errors?: unknown
  } | null
}

export type AvatarOutcome = "ready" | "failed" | "in_flight" | "unknown" | "skipped" | "not_found"

export interface ApplyAvatarResult {
  /** Did this call change the row? False for a replay or an unknown asset. */
  applied: boolean
  outcome: AvatarOutcome
  /** Why nothing was applied, when applied is false. */
  reason?: string
  avatarUrl?: string | null
  /** The operator-facing provider message, when the outcome was a failure. */
  operatorMessage?: string
}

/** A row that has already finished. Re-applying a completion to one of these is
 *  a replay, not new information. */
const TERMINAL_ROW_STATUSES = new Set(["ready", "failed"])

// Same bucket the Twin wizard uses for the uploaded source photo/video.
const AVATAR_BUCKET = "twin-avatars"

type AnyClient = {
  from: (t: string) => any
  storage: { from: (b: string) => any }
}

/**
 * Download the finished D-ID avatar and re-host it in our own bucket, returning
 * the stable public URL.
 *
 * The owner's contract: we do not hot-link the D-ID CDN, because its URLs
 * expire — once the avatar is ready we pull the bytes and serve it ourselves,
 * and it is THAT url (not the D-ID id) the profile stores. Best-effort by
 * design: returns null on any failure so the caller falls back to the D-ID url
 * and the avatar is never left blank.
 */
export async function rehostAvatarImage(
  supabase: AnyClient, assetId: string, sourceUrl: string,
): Promise<string | null> {
  try {
    const res = await fetch(sourceUrl)
    if (!res.ok) return null
    const contentType = res.headers.get("content-type") ?? "image/jpeg"
    const ext = contentType.includes("png") ? "png"
      : contentType.includes("webp") ? "webp"
      : contentType.includes("mp4") ? "mp4"
      : "jpg"
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength === 0) return null
    const path = `rehosted/${assetId}.${ext}`
    const { error } = await supabase.storage.from(AVATAR_BUCKET)
      .upload(path, bytes, { contentType, upsert: true })
    if (error) return null
    const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path)
    return data?.publicUrl ?? null
  } catch {
    return null
  }
}

/**
 * Pick the avatar image to keep.
 *
 * HIGH RES FIRST. thumbnail_url is documented as "a low resolution image" and
 * preview_url as a short GIF, so preferring either over image_url hands the
 * agent a blurry still or an animated loop as their profile picture while the
 * good asset goes unused. Exported so the guard can assert the order.
 */
export function pickAvatarImageUrl(data: DidAvatarPayload): string | null {
  return data.image_url ?? data.thumbnail_url ?? data.preview_url ?? null
}

/**
 * The warning line for an avatar that finished but not cleanly.
 *
 * A VOICE CLONE CAN FAIL ON AN AVATAR THAT OTHERWISE SUCCEEDED. D-ID reports it
 * in creation_notes, and for a long time nothing read it — so the agent got a
 * working face with a silently missing voice, and the first they knew was a
 * video that spoke in a stranger's voice. Returns null when the avatar is clean.
 */
export function avatarWarning(data: DidAvatarPayload): string | null {
  const notes = data.creation_notes ?? null
  if (!notes) return null
  if (notes.is_clone_voice_failed === true) {
    return "The avatar is ready, but its voice clone failed — record a voice sample in Twin Studio."
  }
  const workerErrors = Array.isArray(notes.worker_errors)
    ? notes.worker_errors.filter((e): e is string => typeof e === "string") : []
  if (workerErrors.length > 0) {
    return `The avatar is ready with warnings: ${workerErrors.slice(0, 3).join("; ")}`
  }
  return null
}

/**
 * Apply a D-ID avatar outcome to our row, whoever learned it.
 *
 * Re-reads the asset rather than trusting a row the caller loaded, because the
 * caller may have loaded it before a sibling (webhook or cron) already finished
 * it — that fresh read is the whole idempotency guarantee.
 */
export async function applyAvatarOutcome(
  supabase: AnyClient, assetId: string, data: DidAvatarPayload,
): Promise<ApplyAvatarResult> {
  const { data: asset } = await supabase
    .from("agent_avatar_assets")
    .select("id, agent_id, brokerage_id, did_avatar_id, is_default, label, status")
    .eq("id", assetId)
    .maybeSingle()

  if (!asset) return { applied: false, outcome: "not_found", reason: "no such avatar asset" }
  if (TERMINAL_ROW_STATUSES.has(String(asset.status))) {
    return { applied: false, outcome: "skipped", reason: `already ${asset.status}` }
  }

  const status = String(data.status ?? "").toLowerCase()
  const now = new Date().toISOString()

  // notifications.user_id references users.id, but agent_avatar_assets.agent_id
  // is agents.id — the two are different, and sending to the wrong one puts the
  // notification in nobody's inbox.
  const notifyUserId = await resolveNotifyUser(supabase, asset.agent_id)

  if (status === "done") {
    const didAssetUrl = pickAvatarImageUrl(data)
    const rehosted = didAssetUrl ? await rehostAvatarImage(supabase, assetId, didAssetUrl) : null
    const avatarUrl = rehosted ?? didAssetUrl
    const warning = avatarWarning(data)

    await supabase.from("agent_avatar_assets").update({
      status: "ready",
      thumbnail_url: avatarUrl,
      avatar_url: avatarUrl, // the profile-facing, self-hosted avatar URL
      error_message: warning,
      updated_at: now,
    }).eq("id", assetId)

    // Mirror onto agent_voice_profiles for default avatars so generate-video and
    // chat-widget lookups get it on a single join. The PROFILE stores the bucket
    // URL; did_avatar_id is kept only because clip generation still needs the id.
    if (asset.is_default && asset.agent_id) {
      await supabase.from("agent_voice_profiles")
        .update({ did_avatar_id: asset.did_avatar_id, avatar_url: avatarUrl })
        .eq("agent_id", asset.agent_id)
    }

    if (notifyUserId) {
      await supabase.from("notifications").insert({
        user_id: notifyUserId,
        brokerage_id: asset.brokerage_id,
        type: "avatar_ready",
        title: "Avatar Ready",
        body: `Your avatar "${asset.label}" is ready. Create a video to see it in action.`,
        entity_type: "agent_avatar_asset",
        entity_id: assetId,
        priority: "medium",
        channel: "in_app",
      })
    }

    return { applied: true, outcome: "ready", avatarUrl }
  }

  if (status === "error" || status === "rejected") {
    // The provider's structured {kind, description} turned into something the
    // agent can act on — "we couldn't find a clear face" rather than
    // "InvalidFaceError".
    const failure = classifyDidError(null, data.error ?? data)

    await supabase.from("agent_avatar_assets").update({
      status: "failed",
      error_message: failure.userMessage,
      updated_at: now,
    }).eq("id", assetId)

    if (notifyUserId) {
      await supabase.from("notifications").insert({
        user_id: notifyUserId,
        brokerage_id: asset.brokerage_id,
        type: "avatar_failed",
        title: "Avatar Processing Failed",
        body: `Your avatar "${asset.label}" could not be processed: ${failure.userMessage} Try uploading a different video clip.`,
        entity_type: "agent_avatar_asset",
        entity_id: assetId,
        priority: "high",
        channel: "in_app",
      })
    }

    return { applied: true, outcome: "failed", operatorMessage: failure.operatorMessage }
  }

  // draft | validating | created | started | training-started — still working.
  // Promoted pending → processing only, so a row already marked processing does
  // not churn updated_at on every tick and every redelivery.
  await supabase.from("agent_avatar_assets")
    .update({ status: "processing", updated_at: now })
    .eq("id", assetId).eq("status", "pending")

  return { applied: true, outcome: "in_flight" }
}

/** agents.id → users.id, for the notification inbox. */
async function resolveNotifyUser(supabase: AnyClient, agentId: string | null): Promise<string | null> {
  if (!agentId) return null
  try {
    const { data } = await supabase.from("agents").select("user_id").eq("id", agentId).maybeSingle()
    return (data?.user_id as string | undefined) ?? null
  } catch {
    return null
  }
}
