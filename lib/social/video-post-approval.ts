/**
 * lib/social/video-post-approval.ts — A VIDEO'S SOCIAL POST IS APPROVED BY A PERSON WHO MAY APPROVE IT (wave 153, lane 153P).
 *
 * Lane 153K carried finding: two doors (app/actions/video/distribute-video.ts distributeVideo and lib/kernel/video.ts
 * distributeVideoProject) INSERTED social_posts rows with `approval_status: "approved"` and `status: "scheduled"` — a public
 * post approved by nobody, for a video nobody had classified as public marketing. The publish cron then posted them.
 *
 * Now each door, for each post:
 *   1. classifyPublicVideo (lib/video/public-video.ts — THE one verdict on which videos are public, non-personal marketing).
 *      A 1:1 / client / in-house / MLS-only / unapproved / non-compliant video is REFUSED by its reason, nothing inserted.
 *   2. inserts the post as a DRAFT awaiting approval (status 'draft', approval_status 'pending' — both in the live CHECKs).
 *   3. asks requirePublishApprover (lib/kernel/approval-authority.ts — THE approver resolver) whether the session's user may
 *      approve THIS post. Yes → released (approved_by / approved_at, status 'scheduled'). No / unreadable → it STAYS pending
 *      on the approval surface and the door says who can approve it. Fail closed (§4): nobody checked ≠ approved.
 * Public content keeps its human approval (owner, wave 153: "public ads, spend and regulated content keep theirs").
 */
import { classifyPublicVideo } from "@/lib/video/public-video"

type Db = { from: (t: string) => any }

export interface VideoPostRelease {
  ok: boolean
  postId: string | null
  released: boolean
  /** Why the post was refused, or why it is waiting for someone else's approval. */
  reason: string | null
}

export interface VideoPostDeps {
  /** @proofSeam scripts/marketing-loops-guard.ts — production uses requirePublishApprover. */
  requireApprover?: (i: { brokerageId: string; assetKind: "social_post"; assetTable: string; assetId: string; approverUserId: string; client: Db }) => Promise<{ ok: boolean; reason?: string }>
  now?: () => Date
}

/** The ai_video_projects columns classifyPublicVideo reads — select these, never a subset. */
export const PUBLIC_VIDEO_COLUMNS = "video_type, audience_type, usage_intent, contact_id, learning_module_id, approval_status, status, compliance_status, video_url"

export async function insertVideoSocialPostForApproval(
  svc: Db,
  input: { brokerageId: string; approverUserId: string | null; project: Record<string, unknown>; post: Record<string, unknown> },
  deps: VideoPostDeps = {},
): Promise<VideoPostRelease> {
  const verdict = classifyPublicVideo(input.project as never)
  if (!verdict.public) return { ok: false, postId: null, released: false, reason: `not public marketing: ${verdict.reason}` }
  const now = (deps.now ?? (() => new Date()))().toISOString()
  const { data: row, error } = await svc.from("social_posts").insert({
    ...input.post, brokerage_id: input.brokerageId, status: "draft", approval_status: "pending", created_at: now, updated_at: now,
  }).select("id").maybeSingle()
  if (error) return { ok: false, postId: null, released: false, reason: error.message }
  const postId = ((row as { id?: string } | null)?.id) ?? null
  if (!postId) return { ok: false, postId: null, released: false, reason: "social post insert returned no row" }
  if (!input.approverUserId) return { ok: true, postId, released: false, reason: "awaiting approval — no session user to approve it" }
  const requireApprover = deps.requireApprover ?? (async (i) => (await import("@/lib/kernel/approval-authority")).requirePublishApprover(i as never))
  const gate = await requireApprover({ brokerageId: input.brokerageId, assetKind: "social_post", assetTable: "social_posts", assetId: postId, approverUserId: input.approverUserId, client: svc }).catch((e: unknown) => ({ ok: false, reason: `approver check unavailable: ${e instanceof Error ? e.message : String(e)}` }))
  if (!gate.ok) return { ok: true, postId, released: false, reason: `awaiting approval — ${gate.reason ?? "you are not an approver of this post"}` }
  const { data: upd, error: updErr } = await svc.from("social_posts")
    .update({ approval_status: "approved", approved_by: input.approverUserId, approved_at: now, status: "scheduled", updated_at: now })
    .eq("id", postId).eq("brokerage_id", input.brokerageId).eq("approval_status", "pending").select("id")
  if (updErr) return { ok: true, postId, released: false, reason: `approval not recorded (${updErr.message}) — the post stays pending` }
  if (!Array.isArray(upd) || upd.length === 0) return { ok: true, postId, released: false, reason: "approval matched no pending row — the post stays as it is" }
  return { ok: true, postId, released: true, reason: null }
}
