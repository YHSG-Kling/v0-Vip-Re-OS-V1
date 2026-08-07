/**
 * lib/video/playable-video.ts
 *
 * THE ONE ANSWER TO "what is the playable URL + thumbnail for this finished
 * video?" — for BOTH engines.
 *
 * The OS renders video two ways and files the result in two different tables:
 *
 *   · D-ID (avatar / talking head)  → ai_video_projects
 *       finished  = status ∈ VIDEO_FINISHED_STATUSES  AND video_url present
 *       columns   = video_url, thumbnail_url
 *   · Remotion (most videos)        → remotion_composition_renders
 *       finished  = render_status = 'succeeded'       AND output_url present
 *       columns   = output_url, thumbnail_url
 *
 * Before this module every writer that SENDS a video had its own opinion about
 * which of those it read, and the orchestrator's fan-out (email draft, SMS
 * draft, portal media row, social post, campaign-asset embed) read neither — it
 * trusted a D-ID-shaped event payload and refused outright when `video_url` was
 * absent. Since Remotion finishes most videos, the Remotion half of the product
 * had no path into the fan-out at all.
 *
 * There is now exactly ONE resolver. Every sender calls it, and it answers with
 * a STATE, never a fabricated URL:
 *
 *   ready       → a playable URL exists right now (bucket-hosted; see below)
 *   in_progress → a render is genuinely in flight; wait, do not send
 *   none        → nothing playable will arrive, with the reason on the record
 *
 * PRECEDENCE. A caller may hold both references (a drip section carries a D-ID
 * chapter reel on its body AND its own Remotion section render). READY WINS
 * OVER PENDING, in that order — the point is to deliver a video, so a finished
 * Remotion section reel is used rather than stalling behind a D-ID avatar that
 * is still rendering. `in_progress` is returned only when NOTHING is ready and
 * something is genuinely still coming.
 *
 * THE URL IS A BUCKET URL. Both engines persist their bytes to our own storage
 * on completion (lib/remotion/media-host hostRenderedMedia — Supabase storage
 * first, Vercel Blob fallback), so what this returns does not expire out from
 * under an email that was sent last week. This module does not re-check that;
 * it is a property of the completion paths (render-coordinator,
 * render-composition, poll-did-videos, lib/did).
 *
 * Not server-only on purpose: the pre-listing drip cron imports it and must not
 * drag the orchestrator's handler graph in. Never import it from a client
 * component.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { VIDEO_FINISHED_STATUSES, VIDEO_IN_PROGRESS_STATUSES } from "@/lib/video/video-status"

type Svc = ReturnType<typeof createServiceClient>

/** Which table the playable bytes were resolved from. */
type PlayableVideoSource = "ai_video_project" | "remotion_render"

export type PlayableVideo =
  /** Finished and playable right now. */
  | { state: "ready"; videoUrl: string; thumbnailUrl: string | null; source: PlayableVideoSource }
  /** A render is in flight — the caller should wait rather than send. */
  | { state: "in_progress"; source: PlayableVideoSource }
  /** Nothing playable will arrive. `reason` is always populated. */
  | { state: "none"; reason: string }

/**
 * What to resolve. Either, both, or neither may be set — neither resolves to
 * `none` with a reason rather than throwing, because "this section has no reel
 * attached" is a normal state the drip must be able to describe.
 */
interface PlayableVideoRef {
  /** ai_video_projects.id — the D-ID / Director-commissioned project. */
  videoProjectId?: string | null
  /** remotion_composition_renders.id — the Remotion render. */
  renderId?: string | null
}

/** Remotion render_status values that mean "still coming". */
const RENDER_IN_PROGRESS = ["queued", "rendering"] as const

/**
 * Resolve ONE ai_video_projects row to a playable state.
 *
 * COMPLIANCE IS PART OF "PLAYABLE". A reel whose script postcheck FAILED
 * (lib/video/script-compliance) never reaches a recipient, so it resolves to
 * `none` rather than `ready` — a URL that must not be sent is not a playable
 * URL. 'needs_review' is advisory by design and still ships.
 */
async function resolveVideoProjectPlayable(
  projectId: string,
  client?: Svc,
): Promise<PlayableVideo> {
  const supabase = client ?? createServiceClient()
  const { data, error } = await supabase
    .from("ai_video_projects")
    .select("id, status, video_url, thumbnail_url, compliance_status")
    .eq("id", projectId)
    .maybeSingle()
  if (error) return { state: "none", reason: `video project unreadable: ${error.message}` }
  if (!data) return { state: "none", reason: "video project row not found" }

  const p = data as {
    status: string | null
    video_url: string | null
    thumbnail_url: string | null
    compliance_status: string | null
  }
  if (p.compliance_status === "failed") {
    return { state: "none", reason: "video failed the script compliance postcheck" }
  }
  if ((VIDEO_FINISHED_STATUSES as readonly string[]).includes(p.status ?? "") && p.video_url) {
    return { state: "ready", videoUrl: p.video_url, thumbnailUrl: p.thumbnail_url, source: "ai_video_project" }
  }
  if ((VIDEO_IN_PROGRESS_STATUSES as readonly string[]).includes(p.status ?? "")) {
    return { state: "in_progress", source: "ai_video_project" }
  }
  return { state: "none", reason: `video project is '${p.status ?? "unknown"}' with no playable URL` }
}

/** Resolve ONE remotion_composition_renders row to a playable state. */
async function resolveRemotionRenderPlayable(
  renderId: string,
  client?: Svc,
): Promise<PlayableVideo> {
  const supabase = client ?? createServiceClient()
  const { data, error } = await supabase
    .from("remotion_composition_renders")
    .select("id, render_status, output_url, thumbnail_url")
    .eq("id", renderId)
    .maybeSingle()
  if (error) return { state: "none", reason: `remotion render unreadable: ${error.message}` }
  if (!data) return { state: "none", reason: "remotion render row not found" }

  const r = data as { render_status: string | null; output_url: string | null; thumbnail_url: string | null }
  if (r.render_status === "succeeded" && r.output_url) {
    return { state: "ready", videoUrl: r.output_url, thumbnailUrl: r.thumbnail_url, source: "remotion_render" }
  }
  if ((RENDER_IN_PROGRESS as readonly string[]).includes(r.render_status ?? "")) {
    return { state: "in_progress", source: "remotion_render" }
  }
  return { state: "none", reason: `remotion render is '${r.render_status ?? "unknown"}' with no output URL` }
}

/**
 * THE resolver. Reads whichever references the caller holds and returns the
 * best available state: ready first, then in_progress, then none with every
 * reason joined so a human can see exactly why nothing was playable.
 *
 * The project is probed before the render because when both exist the project
 * is the finished DELIVERABLE (render-composition stamps the branded composite
 * onto ai_video_projects.video_url) and the render is its raw ingredient.
 */
export async function resolvePlayableVideo(
  ref: PlayableVideoRef,
  client?: Svc,
): Promise<PlayableVideo> {
  const supabase = client ?? createServiceClient()
  const reasons: string[] = []
  let pending: PlayableVideo | null = null

  for (const probe of [
    ref.videoProjectId ? () => resolveVideoProjectPlayable(ref.videoProjectId!, supabase) : null,
    ref.renderId ? () => resolveRemotionRenderPlayable(ref.renderId!, supabase) : null,
  ]) {
    if (!probe) continue
    const got = await probe()
    if (got.state === "ready") return got
    if (got.state === "in_progress") { pending = pending ?? got; continue }
    reasons.push(got.reason)
  }

  if (pending) return pending
  return { state: "none", reason: reasons.length ? reasons.join("; ") : "no video reference supplied" }
}
