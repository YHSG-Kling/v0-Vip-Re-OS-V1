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
  learning_module_id?: string | null
  approval_status: string | null
  status: string | null
  compliance_status: string | null
  video_url: string | null
  script_content: string | null
  video_metadata: Record<string, unknown> | null
}

const PROJECT_COLUMNS = "id, brokerage_id, agent_id, listing_id, marketing_campaign_id, title, video_type, audience_type, usage_intent, contact_id, learning_module_id, approval_status, status, compliance_status, video_url, script_content, video_metadata"

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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WAVE 143 (lane 143F) — closes the two 142K open items on this rail.
//
//   1. PRIVACY IS EXPLICIT, AND DECIDED AT SEND TIME. publishToYouTube no longer defaults to "public"
//      (lib/social/publisher.ts PublishParams.privacyStatus is required). The queue above classifies when it
//      STAGES a post; the cron sends later, and a human can also draft a YouTube post of any file. So the
//      send re-asks the SAME classification about the file it is about to upload: a public-marketing video →
//      "public"; a file that is one of OUR video projects but is NOT public marketing (a thank-you to a client,
//      an unapproved cut, the MLS cut, an in-house video) → "private" — never broadcast; a file that is no video
//      project of ours (a human composed that YouTube post) → "public", the human approved it; a refused read →
//      no answer (the cron holds the post — fail closed, never a guess).
//   2. THE CONNECT BACKFILL. queueYouTubeAutoPublish refuses with "no active YouTube account is connected" and
//      nothing ever retried: every video approved BEFORE the tenant connected its channel stayed off YouTube
//      for good. backfillYouTubeAutoPublish re-asks that question for the tenant's approved public-marketing
//      videos that were never queued; sweepYouTubeBackfill is the bounded cron-side net over tenants that have
//      an active channel (the publish-social-posts cron runs it — cron is the backup, the approval and the
//      render-landed doors are the primary). Idempotent: the queue is idempotent on the brief key, and a video
//      already queued or published is skipped by its video_metadata.youtube stamp before the queue is asked.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type YouTubePrivacyBasis = "classified_public_marketing" | "held_private_not_public_marketing" | "human_post_unclassified_file"

export type YouTubePrivacyResolution =
  | { ok: true; privacyStatus: "public" | "private"; basis: YouTubePrivacyBasis; detail: string }
  | { ok: false; reason: string }

/**
 * The upload's privacyStatus for ONE post about to be sent. Tenant-pinned (the post's own brokerage_id); never throws.
 * @proofSeam scripts/video-pipeline-truth-guard.ts drives every branch on an in-memory client.
 */
export async function resolveYouTubePrivacy(
  svc: any,
  post: { brokerage_id: string | null; media_urls?: string[] | null; post_brief?: string | null },
): Promise<YouTubePrivacyResolution> {
  try {
    if (!post.brokerage_id) return { ok: false, reason: "post has no tenant — the file cannot be classified" }
    const videoUrl = Array.isArray(post.media_urls) && post.media_urls.length > 0 ? post.media_urls[0] : null
    let row: ProjectRow | null = null
    const projectId = videoProjectIdFromBrief(post.post_brief)
    if (projectId) {
      const { data, error } = await svc.from("ai_video_projects").select(PROJECT_COLUMNS).eq("id", projectId).eq("brokerage_id", post.brokerage_id).maybeSingle()
      if (error) return { ok: false, reason: `video project read refused: ${error.message}` }
      row = (data as ProjectRow | null) ?? null
    }
    if (!row && videoUrl) {
      const { data, error } = await svc.from("ai_video_projects").select(PROJECT_COLUMNS).eq("brokerage_id", post.brokerage_id).eq("video_url", videoUrl).limit(1).maybeSingle()
      if (error) return { ok: false, reason: `video project read refused: ${error.message}` }
      row = (data as ProjectRow | null) ?? null
    }
    if (!row) return { ok: true, privacyStatus: "public", basis: "human_post_unclassified_file", detail: "the file is not one of this tenant's video projects — a human composed and approved this YouTube post" }
    const verdict = classifyPublicVideo(row)
    if (verdict.public) return { ok: true, privacyStatus: "public", basis: "classified_public_marketing", detail: `video project ${row.id} (${row.video_type}) is approved public marketing` }
    return { ok: true, privacyStatus: "private", basis: "held_private_not_public_marketing", detail: `video project ${row.id} is not public marketing (${verdict.reason}) — uploaded PRIVATE, never broadcast` }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}

export interface YouTubeBackfillOutcome {
  /** Public-marketing videos looked at (after the already-stamped ones were set aside). */
  examined: number
  queued: number
  alreadyQueued: number
  skipped: Array<{ id: string; reason: string }>
  /** Set when the tenant has no active YouTube account (nothing to do) or a read was refused (the reason). */
  note?: string
}

/**
 * Queue the tenant's approved public-marketing videos that were finished before its YouTube channel was
 * connected. Newest first, bounded (`limit`, default 10), tenant-pinned. Never throws.
 * Callers: app/actions/youtube-backfill.ts queueApprovedVideosToYouTubeAction (the "Send approved videos to YouTube" button on the videos library,
 * tenant admin, session tenant) and sweepYouTubeBackfill below (the publish-social-posts cron). scripts/video-pipeline-truth-guard.ts drives one
 * tenant's backfill (before / after connect, idempotent, policy off, unreadable, bounded). The OAuth connect callback is the immediate hook (outside
 * this lane's files — see the lane notes); until it calls this, the button and the cron are the doors.
 */
export async function backfillYouTubeAutoPublish(svc: any, brokerageId: string, opts: { limit?: number } = {}): Promise<YouTubeBackfillOutcome> {
  const out: YouTubeBackfillOutcome = { examined: 0, queued: 0, alreadyQueued: 0, skipped: [] }
  try {
    if (!brokerageId) return { ...out, note: "no tenant" }
    const { data: accts, error: acctErr } = await svc.from("social_media_accounts").select("id").eq("brokerage_id", brokerageId).eq("platform", "youtube").eq("is_active", true).limit(1)
    if (acctErr) return { ...out, note: `YouTube account read refused: ${acctErr.message}` }
    if (!accts || accts.length === 0) return { ...out, note: "no active YouTube account — nothing to backfill" }

    const policy = await readVideoAutoPublishPolicy(svc, brokerageId)
    if (!policy.readable) return { ...out, note: `tenant policy ${VIDEO_AUTO_PUBLISH_POLICY_KEY} unreadable — refusing to publish on a guess: ${policy.reason}` }
    if (!policy.youtube) return { ...out, note: `tenant policy ${VIDEO_AUTO_PUBLISH_POLICY_KEY}.youtube is off` }

    const { PUBLIC_MARKETING_VIDEO_TYPES } = await import("./public-video")
    const { data, error } = await svc.from("ai_video_projects")
      .select("id, video_metadata, video_type, contact_id, learning_module_id, approval_status, status, compliance_status, video_url, audience_type, usage_intent")
      .eq("brokerage_id", brokerageId)
      .in("video_type", [...PUBLIC_MARKETING_VIDEO_TYPES])
      .is("contact_id", null)
      .in("approval_status", ["approved", "published"])
      .not("video_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(100)
    if (error) return { ...out, note: `video projects read refused: ${error.message}` }

    const limit = Math.max(1, Math.min(opts.limit ?? 10, 25))
    const candidates = ((data ?? []) as Array<ProjectRow>)
      // Already queued or already on the channel → the stamp says so; never ask the queue again each tick.
      .filter((r) => { const yt = (r.video_metadata?.youtube ?? null) as Record<string, unknown> | null; return !(yt && (yt.queued_social_post_id || yt.video_id)) })
      .filter((r) => classifyPublicVideo(r).public)
      .slice(0, limit)
    out.examined = candidates.length
    for (const c of candidates) {
      const r = await queueYouTubeAutoPublish(svc, c.id)
      if (r.queued) { if (r.alreadyQueued) out.alreadyQueued++; else out.queued++ }
      else out.skipped.push({ id: c.id, reason: r.reason })
    }
    return out
  } catch (e) {
    return { ...out, note: (e as Error).message }
  }
}

/**
 * The cron-side net: every tenant with an ACTIVE YouTube account gets its backfill (bounded: `maxTenants` per tick,
 * `perTenant` videos each). Returns what it did so the cron can print it; never throws.
 */
export async function sweepYouTubeBackfill(svc: any, opts: { maxTenants?: number; perTenant?: number } = {}): Promise<{ tenants: number; queued: number; notes: string[] }> {
  const res = { tenants: 0, queued: 0, notes: [] as string[] }
  try {
    const { data, error } = await svc.from("social_media_accounts").select("brokerage_id").eq("platform", "youtube").eq("is_active", true).not("brokerage_id", "is", null).limit(200)
    if (error) { res.notes.push(`YouTube accounts read refused: ${error.message}`); return res }
    const ids = [...new Set(((data ?? []) as Array<{ brokerage_id: string | null }>).map((r) => r.brokerage_id).filter((x): x is string => !!x))].slice(0, Math.max(1, opts.maxTenants ?? 25))
    for (const id of ids) {
      const r = await backfillYouTubeAutoPublish(svc, id, { limit: opts.perTenant ?? 5 })
      res.tenants++
      res.queued += r.queued
      if (r.note && !/nothing to backfill/.test(r.note)) res.notes.push(`${id}: ${r.note}`)
      for (const s of r.skipped) res.notes.push(`${id}/${s.id}: ${s.reason}`)
    }
  } catch (e) {
    res.notes.push((e as Error).message)
  }
  return res
}
