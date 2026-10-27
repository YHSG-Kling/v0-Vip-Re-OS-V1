// lib/video/community-video-publish.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE COMMUNITY / EVENT VIDEO PUBLICATION DOOR (wave 145, lane 145G — the 144H open item: "community/event (topic) videos have
// no separate publication door — they go public only through the YouTube / landing / TV / social doors").
//
// The smallest door ON the existing publication survivor — no new rail, no new upload path. A community video is a video made
// FROM a topic the brokerage approved as a campaign idea (a verified local event / civic notice — lib/content-intel/local-intel.ts —
// or any intelligence topic — lib/content-intel/topic-intelligence.ts). It publishes only when ALL of these hold, each refusal
// named and nothing written:
//   1. a PERSON approved the topic's campaign idea (approval_items local_campaign_idea / topic_campaign_idea, status approved),
//      and the topic is still in the tenant's pool and unexpired — an event that already happened is a recap, never promoted;
//   2. the video was made FROM that topic (the topic claim its producer wrote — content_topic_uses);
//   3. the video is an APPROVED PUBLIC MARKETING video (lib/video/public-video.ts classifyPublicVideo — approved by a person,
//      compliance passed, finished, addressed to nobody, not the MLS cut);
// then it rides THE survivor — lib/video/youtube-publish.ts queueYouTubeAutoPublish (the tenant switch, the connected
// account, the final personalization phase of the post's words, the publish cron's own compliance + ledger) — and the video
// carries the evidence (video_metadata.community: topic, who approved it, when, which door). Never throws.

import { classifyPublicVideo } from "./public-video"
import { queueYouTubeAutoPublish, type YouTubeBrandResolver } from "./youtube-publish"
import { readTopicApproval } from "@/lib/content-intel/topic-intelligence"

type Db = { from: (table: string) => any }

export interface PublishCommunityVideoInput {
  /** The VERIFIED tenant (session) — never a request body. */
  brokerageId: string
  /** users.id of the person publishing (the evidence's actor). */
  actorUserId: string
  videoProjectId: string
  topicId: string
}

export type PublishCommunityVideoResult =
  | { ok: true; socialPostId: string; alreadyQueued: boolean; topicTitle: string }
  | { ok: false; reason: string }

export async function publishCommunityVideo(input: PublishCommunityVideoInput, deps: { client?: Db; now?: Date; brand?: YouTubeBrandResolver; queue?: typeof queueYouTubeAutoPublish } = {}): Promise<PublishCommunityVideoResult> {
  try {
    if (!input.brokerageId || !input.actorUserId || !input.videoProjectId || !input.topicId) return { ok: false, reason: "tenant, publisher, video and topic are required" }
    const db = deps.client ?? ((await import("@/lib/supabase/service")).createServiceClient() as unknown as Db)
    const now = deps.now ?? new Date()

    // 1 · the topic's campaign idea was approved by a person, and the topic is still live in this tenant's pool.
    const topic = await readTopicApproval(db, input.brokerageId, input.topicId, { now })
    if (topic.error) return { ok: false, reason: topic.error }
    if (!topic.approved || !topic.topic) return { ok: false, reason: `the topic is not approved for publication — ${topic.reason}` }

    // 2 + 3 · the video: this tenant's, made FROM the topic, an approved public marketing video.
    const { data, error } = await db.from("ai_video_projects")
      .select("id, brokerage_id, title, video_type, audience_type, usage_intent, contact_id, learning_module_id, approval_status, status, compliance_status, video_url, video_metadata")
      .eq("id", input.videoProjectId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (error) return { ok: false, reason: `ai_video_projects read refused: ${error.message ?? "unknown"}` }
    const v = data as Record<string, any> | null
    if (!v) return { ok: false, reason: "the video is not this brokerage's" }
    const { data: uses, error: useErr } = await db.from("content_topic_uses").select("id").eq("brokerage_id", input.brokerageId).eq("topic_id", input.topicId).eq("asset_id", input.videoProjectId).limit(1)
    if (useErr) return { ok: false, reason: `content_topic_uses read refused: ${useErr.message ?? "unknown"}` }
    if ((uses ?? []).length === 0) return { ok: false, reason: "the video was not made from this topic (no topic claim links them)" }
    const verdict = classifyPublicVideo(v)
    if (!verdict.public) return { ok: false, reason: `not an approved public marketing video (${verdict.reason})` }

    // The evidence on the asset, BEFORE it rides the rail (a counted write — a stamp that did not land refuses the publish).
    const meta = (v.video_metadata ?? {}) as Record<string, unknown>
    const community = { topic_id: input.topicId, topic_title: topic.topic.title, topic_approved_by: topic.approvedBy, topic_approved_at: topic.approvedAt, requested_by: input.actorUserId, requested_at: now.toISOString(), door: "community_video_publish" }
    const { data: stamped, error: stampErr } = await db.from("ai_video_projects").update({ video_metadata: { ...meta, community }, updated_at: now.toISOString() })
      .eq("id", input.videoProjectId).eq("brokerage_id", input.brokerageId).select("id")
    if (stampErr || (stamped ?? []).length !== 1) return { ok: false, reason: `the community evidence was not recorded — not published: ${stampErr?.message ?? "matched no row"}` }

    // THE SURVIVOR: the YouTube rail (tenant switch, connected account, the final personalization phase, the cron's gates).
    const q = await (deps.queue ?? queueYouTubeAutoPublish)(db, input.videoProjectId, { brand: deps.brand })
    if (!q.queued) return { ok: false, reason: `the publication rail refused: ${q.reason}` }
    return { ok: true, socialPostId: q.socialPostId, alreadyQueued: q.alreadyQueued, topicTitle: topic.topic.title }
  } catch (e) {
    return { ok: false, reason: `publishCommunityVideo threw: ${(e as Error)?.message ?? String(e)}` }
  }
}
