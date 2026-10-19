/**
 * lib/video/youtube-publish.ts — APPROVED NON-PERSONAL VIDEOS GO TO YOUTUBE THROUGH THE
 * EXISTING AUTHORIZED PATH, AND THE RESULT COMES BACK ONTO THE ASSET (wave 142, lane 142F).
 *
 * OWNER (2026-10-18): "all videos that are not personal should also be added to youtube."
 *
 * THE SURVIVOR IS NOT REPLACED. The OS already has ONE authorized YouTube rail:
 *   social_posts (platform 'youtube', approval_status 'approved', status 'scheduled')
 *     → app/api/cron/publish-social-posts (hourly; brand compliance + disclosures +
 *       withActionLedger marketing.social.publish — one publish per (post, platform, account))
 *     → lib/social/publisher.ts publishToYouTube (resumable upload on the connector gateway,
 *       the tenant's own OAuth token from social_media_accounts — youtube.upload scope,
 *       lib/social/oauth-config.ts) → external_post_id = the YouTube video id.
 * lib/kernel/video.ts distributeVideoProject (a human's session door) and
 * proposeGatedVideoDistribution (a gated multi-channel draft) both already queue onto it.
 * What was MISSING was the RULE — nothing queued a YouTube post automatically after a
 * broker approved a public marketing video — and the WRITE-BACK — the YouTube id lived
 * on the social_posts row only, so a campaign, a lead magnet or a follow-up could not
 * find "this video on YouTube" from the asset. Both halves are here:
 *
 *   queueYouTubeAutoPublish  — after HUMAN APPROVAL (lib/kernel/approval-queue-aggregator.ts
 *     applyMarketingAssetApproval("video")) or when the render lands on an already-approved
 *     video (lib/orchestrator/internal.ts handleVideoGenerated), classify the row
 *     (lib/video/public-video.ts — public marketing kind, addressed to nobody, not in-house,
 *     not the MLS cut, finished + compliance passed + approved), read the tenant switch
 *     (policy key video_auto_publish, default ON; unreadable = refuse), find the tenant's
 *     ACTIVE YouTube account, and stage ONE social_posts row (idempotent on the post_brief
 *     key; privacy 'public' by construction — nothing non-public is ever queued, so no
 *     'unlisted' or 'private' upload of client media can happen). The approval is the
 *     human gate; the publish cron's compliance + ledger still run on send.
 *   recordYouTubePublishOnAsset — when the cron publishes a youtube post, stamp
 *     ai_video_projects.video_metadata.youtube {video_id, url, published_at,
 *     social_post_id} and the same block on every marketing_assets row carrying that
 *     file (metadata.youtube), so every reuse surface (campaigns, lead magnets, follow-up)
 *     reads the YouTube reference off the asset it already holds.
 *
 * NEVER: a video addressed to a contact, an in-house cut, transaction / client media, an
 * unapproved or compliance-failed asset, or a tenant that switched the rule off. Every
 * refusal returns its reason; nothing here throws into an approval or a render.
 * Tenant-pinned reads and writes throughout (the project's own brokerage_id); the caller's
 * client is used so a proof can drive it in memory.
 */
import { classifyPublicVideo, readVideoAutoPublishPolicy, VIDEO_AUTO_PUBLISH_POLICY_KEY } from "./public-video"
import { getPublishedPostUrl } from "@/lib/social/get-published-post-url"

/** social_posts.post_brief key — ONE spelling, exact-match idempotency (never a LIKE scan). */
const YOUTUBE_AUTO_PUBLISH_BRIEF_PREFIX = "YOUTUBE AUTO-PUBLISH — video_project:"

/** @proofSeam scripts/video-pipeline-truth-guard.ts asserts the queued post carries exactly this key. */
export function youtubeAutoPublishBrief(videoId: string): string {
  return `${YOUTUBE_AUTO_PUBLISH_BRIEF_PREFIX}${videoId}`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The project a youtube post was queued for, read back off its brief; null for any other post.
 * @proofSeam scripts/video-pipeline-truth-guard.ts asserts only this module's brief with a uuid reads back. */
export function videoProjectIdFromBrief(brief: unknown): string | null {
  if (typeof brief !== "string" || !brief.startsWith(YOUTUBE_AUTO_PUBLISH_BRIEF_PREFIX)) return null
  const id = brief.slice(YOUTUBE_AUTO_PUBLISH_BRIEF_PREFIX.length).trim()
  return UUID_RE.test(id) ? id : null
}

/** ai_video_projects.video_type → social_posts.post_type (its live CHECK vocabulary).
 * @proofSeam scripts/video-pipeline-truth-guard.ts holds every mapped value inside the live CHECK. */
export function youtubePostTypeFor(videoType: string | null | undefined): string {
  switch (videoType) {
    case "just_listed": case "listing_promo": return "new_listing"
    case "just_sold": return "just_sold"
    case "coming_soon": return "coming_soon"
    case "open_house_promo": return "open_house_announcement"
    case "market_update": return "market_update"
    default: return "custom"
  }
}

type YouTubeQueueOutcome =
  | { queued: true; socialPostId: string; alreadyQueued: boolean }
  | { queued: false; reason: string }

interface ProjectRow {
  id: string
  brokerage_id: string | null
  agent_id: string | null
  listing_id: string | null
  marketing_campaign_id: string | null
  title: string | null
  video_type: string | null
  audience_type: string | null
  usage_intent: string | null
  contact_id: string | null
  approval_status: string | null
  status: string | null
  compliance_status: string | null
  video_url: string | null
  script_content: string | null
  video_metadata: Record<string, unknown> | null
}

const PROJECT_COLUMNS = "id, brokerage_id, agent_id, listing_id, marketing_campaign_id, title, video_type, audience_type, usage_intent, contact_id, approval_status, status, compliance_status, video_url, script_content, video_metadata"

/**
 * Stage the YouTube publish for ONE approved video. Idempotent per video. Never throws.
 */
export async function queueYouTubeAutoPublish(svc: any, videoId: string): Promise<YouTubeQueueOutcome> {
  try {
    const { data, error } = await svc.from("ai_video_projects").select(PROJECT_COLUMNS).eq("id", videoId).maybeSingle()
    if (error) return { queued: false, reason: `video read refused: ${error.message}` }
    const p = data as ProjectRow | null
    if (!p) return { queued: false, reason: "video not found" }
    if (!p.brokerage_id) return { queued: false, reason: "video has no tenant" }

    const verdict = classifyPublicVideo(p)
    if (!verdict.public) return { queued: false, reason: `not a public marketing video: ${verdict.reason}` }

    const policy = await readVideoAutoPublishPolicy(svc, p.brokerage_id)
    if (!policy.readable) return { queued: false, reason: `tenant policy ${VIDEO_AUTO_PUBLISH_POLICY_KEY} unreadable — refusing to publish on a guess: ${policy.reason}` }
    if (!policy.youtube) return { queued: false, reason: `tenant policy ${VIDEO_AUTO_PUBLISH_POLICY_KEY}.youtube is off` }

    const brief = youtubeAutoPublishBrief(p.id)
    const { data: existing, error: existErr } = await svc.from("social_posts")
      .select("id").eq("brokerage_id", p.brokerage_id).eq("platform", "youtube").eq("post_brief", brief).limit(1).maybeSingle()
    if (existErr) return { queued: false, reason: `idempotency read refused: ${existErr.message}` }
    if (existing) return { queued: true, socialPostId: (existing as { id: string }).id, alreadyQueued: true }

    const { data: accounts, error: acctErr } = await svc.from("social_media_accounts")
      .select("id, agent_id").eq("brokerage_id", p.brokerage_id).eq("platform", "youtube").eq("is_active", true).limit(5)
    if (acctErr) return { queued: false, reason: `YouTube account read refused: ${acctErr.message}` }
    const rows = (accounts ?? []) as Array<{ id: string; agent_id: string | null }>
    const account = rows.find((a) => p.agent_id && a.agent_id === p.agent_id) ?? rows[0] ?? null
    if (!account) return { queued: false, reason: "no active YouTube account is connected for this brokerage (Settings → Connections)" }

    // social_posts.user_id is users-class; ai_video_projects.agent_id is agents-class (m366) — cross via agents.user_id (§3).
    let userId: string | null = null
    if (p.agent_id) {
      const { data: agent } = await svc.from("agents").select("user_id").eq("id", p.agent_id).eq("brokerage_id", p.brokerage_id).maybeSingle()
      userId = (agent as { user_id?: string | null } | null)?.user_id ?? null
    }

    const title = (p.title && p.title.trim()) || `${String(p.video_type ?? "video").replace(/_/g, " ")} video`
    const excerpt = (p.script_content ?? "").trim().replace(/\s+/g, " ").slice(0, 600)
    const content = excerpt ? `${title}\n\n${excerpt}` : title
    const now = new Date().toISOString()

    const { data: inserted, error: insErr } = await svc.from("social_posts").insert({
      brokerage_id:          p.brokerage_id,
      agent_id:              p.agent_id,
      user_id:               userId,
      social_account_id:     account.id,
      listing_id:            p.listing_id ?? null,
      marketing_campaign_id: p.marketing_campaign_id ?? null,
      platform:              "youtube",
      post_type:             youtubePostTypeFor(p.video_type),
      content,
      media_urls:            [p.video_url],
      hashtags:              [],
      status:                "scheduled",
      approval_status:       "approved",
      scheduled_for:         now,
      ai_generated:          true,
      post_brief:            brief,
      created_at:            now,
    }).select("id").maybeSingle()
    if (insErr || !inserted) return { queued: false, reason: `social_posts insert refused: ${insErr?.message ?? "no row returned"}` }
    const socialPostId = (inserted as { id: string }).id

    // The decision's evidence on the asset itself: why it was queued, under which rule, and the
    // post that carries it — the slot recordYouTubePublishOnAsset fills with the id + url later.
    const prevYt = (p.video_metadata?.youtube && typeof p.video_metadata.youtube === "object") ? (p.video_metadata.youtube as Record<string, unknown>) : {}
    const { data: stamped, error: stampErr } = await svc.from("ai_video_projects").update({
      video_metadata: {
        ...(p.video_metadata ?? {}),
        youtube: { ...prevYt, queued_social_post_id: socialPostId, queued_at: now, privacy: verdict.privacy, rule: "auto_publish_after_approval", policy_key: VIDEO_AUTO_PUBLISH_POLICY_KEY },
      },
      updated_at: now,
    }).eq("id", p.id).eq("brokerage_id", p.brokerage_id).select("id")
    if (stampErr || !stamped || stamped.length === 0) {
      console.error(`[youtube-publish] queued post ${socialPostId} for video ${p.id} but the video_metadata stamp ${stampErr ? `was refused: ${stampErr.message}` : "matched no row"}`)
    }
    return { queued: true, socialPostId, alreadyQueued: false }
  } catch (e) {
    return { queued: false, reason: (e as Error).message }
  }
}

interface PublishedYouTubePost {
  id: string
  brokerage_id: string | null
  platform: string | null
  external_post_id: string | null
  media_urls: string[] | null
  post_brief: string | null
  published_at?: string | null
}

interface YouTubeRecordOutcome {
  ok: boolean
  projectId: string | null
  url: string | null
  assetsStamped: number
  reason?: string
}

/**
 * The write-back: a published youtube post's id + url onto the video project and every
 * marketing_assets row that carries the same file. Idempotent (a re-run writes the same
 * values). Never throws — the publish already happened; a refused stamp is reported.
 */
export async function recordYouTubePublishOnAsset(svc: any, post: PublishedYouTubePost): Promise<YouTubeRecordOutcome> {
  const none = (reason: string): YouTubeRecordOutcome => ({ ok: false, projectId: null, url: null, assetsStamped: 0, reason })
  try {
    if ((post.platform ?? "").toLowerCase() !== "youtube") return none("not a youtube post")
    if (!post.external_post_id) return none("the provider returned no video id — nothing to record")
    if (!post.brokerage_id) return none("post has no tenant")
    const url = getPublishedPostUrl("youtube", post.external_post_id)
    const publishedAt = post.published_at ?? new Date().toISOString()
    const videoUrl = Array.isArray(post.media_urls) && post.media_urls.length > 0 ? post.media_urls[0] : null

    // The project: by the brief this module wrote, else by the file the post carried.
    type ProjectStamp = { id: string; video_metadata: Record<string, unknown> | null; status: string | null }
    let projectId = videoProjectIdFromBrief(post.post_brief)
    let project: ProjectStamp | null = null
    if (projectId) {
      const { data } = await svc.from("ai_video_projects").select("id, video_metadata, status").eq("id", projectId).eq("brokerage_id", post.brokerage_id).maybeSingle()
      project = (data as ProjectStamp | null) ?? null
    }
    if (!project && videoUrl) {
      const { data } = await svc.from("ai_video_projects").select("id, video_metadata, status").eq("brokerage_id", post.brokerage_id).eq("video_url", videoUrl).limit(1).maybeSingle()
      project = (data as ProjectStamp | null) ?? null
    }
    projectId = project?.id ?? null

    const stamp = { video_id: post.external_post_id, url, published_at: publishedAt, social_post_id: post.id }
    if (project) {
      const prevYt = (project.video_metadata?.youtube && typeof project.video_metadata.youtube === "object") ? (project.video_metadata.youtube as Record<string, unknown>) : {}
      const { data: stamped, error } = await svc.from("ai_video_projects").update({
        video_metadata: { ...(project.video_metadata ?? {}), youtube: { ...prevYt, ...stamp } },
        updated_at: publishedAt,
      }).eq("id", project.id).eq("brokerage_id", post.brokerage_id).select("id")
      if (error || !stamped || stamped.length === 0) {
        return { ok: false, projectId, url, assetsStamped: 0, reason: `project stamp ${error ? `refused: ${error.message}` : "matched no row"}` }
      }
      // The reel went OUT — 'published' is post-terminal and still a finished video (lib/video/video-status.ts).
      if (project.status === "completed") {
        const { error: stErr } = await svc.from("ai_video_projects").update({ status: "published", published_at: publishedAt })
          .eq("id", project.id).eq("brokerage_id", post.brokerage_id).eq("status", "completed")
        if (stErr) console.error(`[youtube-publish] project ${project.id} status → published refused: ${stErr.message}`)
      }
    }

    // Every library copy of the same file (lib/marketing/capture-render-asset.ts captures renders there).
    let assetsStamped = 0
    if (videoUrl) {
      const { data: assets, error: aErr } = await svc.from("marketing_assets").select("id, metadata")
        .eq("brokerage_id", post.brokerage_id).eq("asset_url", videoUrl).limit(20)
      if (aErr) console.error(`[youtube-publish] marketing_assets read refused: ${aErr.message}`)
      for (const a of (assets ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>) {
        const { data: done, error } = await svc.from("marketing_assets").update({
          metadata: { ...(a.metadata ?? {}), youtube: stamp },
          updated_at: publishedAt,
        }).eq("id", a.id).eq("brokerage_id", post.brokerage_id).select("id")
        if (!error && done && done.length > 0) assetsStamped += done.length
        else console.error(`[youtube-publish] marketing_assets ${a.id} youtube stamp ${error ? `refused: ${error.message}` : "matched no row"}`)
      }
    }
    return { ok: !!project || assetsStamped > 0, projectId, url, assetsStamped, reason: !project && assetsStamped === 0 ? "no project or asset carries this post's file" : undefined }
  } catch (e) {
    return none((e as Error).message)
  }
}
