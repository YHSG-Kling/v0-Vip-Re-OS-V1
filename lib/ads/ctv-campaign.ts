// lib/ads/ctv-campaign.ts
// STREAMING-TV AD LANE — the CTV campaign composer (Vibe.co).
//
// Two honest layers (owner directive: "part of ads should be pushing to
// streaming tv with video ads using vibe.co"):
//   1. THIS FILE — everything the OS can genuinely do today: validate a
//      rendered video against the CTV checks we CAN run (url present,
//      15s/30s spot length from duration_seconds, 16:9 when the format is
//      recorded), stage the campaign as an ad_campaigns row
//      (platform='vibe_ctv', status='draft'), and return a complete LAUNCH
//      PACKAGE — creative link, targeting + budget summaries, a real launch
//      checklist, and the vibe.co deep link.
//   2. lib/providers/vibe.ts — the LIVE connector (OAuth2 client credentials →
//      creative upload → campaign → strategy → PUBLISH). Dispatch FAILS HONESTLY
//      with the real reason when the brokerage has no Vibe credential; then
//      status stays 'draft' until a human marks launched.
//   3. launchCtvCampaignOnVibe (below) — the one flip-to-live for the API path,
//      shared by the server action and the Ads Manager executor; and
//      stageCtvCampaignForVideo — the autonomous staging a finished promotable
//      render triggers through the manager bus.
//
// No simulated launches, no fake external ids — same honesty rule as the rest
// of the ads domain (lib/ads/launch-assembler.ts: "no fake live state").
//
// CONVERGENCE WITH THE TV JUDGE (wave 144, lane 144H; owner ruling 16: "the TV-ad
// provider was built in the Ads Manager — verify and reuse; do not duplicate;
// wave 143's lib/video/tv-spot*.ts is the creative spec/judge side"). THIS file
// stays the ONE streaming-TV provider path; it now READS the judge instead of
// shipping the social reel:
//   · a TV ad is a BROADCAST — the creative must pass lib/video/public-video.ts
//     classifyPublicVideo (approved by a human, compliance passed, a public
//     marketing class, addressed to nobody, not the MLS-only cut) — the SAME gate
//     the TV master and YouTube ride; a client's, personal or unapproved video is
//     refused by name at staging AND at launch;
//   · the creative uploaded to Vibe is the TV MASTER the judge recorded
//     (video_metadata.tv_spot — the spec in lib/video/tv-spot.ts TV_SPOT_SPEC), never
//     the −14 LUFS social master in video_url. A master that FAILED its checks is
//     refused naming them; with no master yet a draft may still be STAGED (a
//     draft broadcasts nothing) but the LAUNCH — the authoritative write, both the
//     executor/action door (launchCtvCampaignOnVibe) and the connector door
//     (lib/ads/connectors/vibe-ctv.ts) — is refused until a READY master exists
//     (ensureCtvBroadcastReady). The judge's numbers are not re-spelled here.
//
// TOPIC → TV (wave 145, lane 145D — cross-lane contract C5; owner ruling 13: "TV ads derive from the topic bank",
// ruling 22: the topic bank feeds TV/CTV ads). This file stays the ONE TV gateway; it now ALSO takes
// { topicId, assetId } — the asset is the ai_video_projects row (assetId is the contract's name for videoProjectId) and
// the topic is a content_topic_bank row a PERSON approved for TV: an approval_items row of this tenant whose latest
// decision on that topic is 'approved' (item types CTV_TOPIC_APPROVAL_ITEM_TYPES below). An unapproved, rejected,
// foreign or unreadable topic is REFUSED at staging (no draft row) and RE-CHECKED at launch inside the shared gate
// (ensureCtvBroadcastReady), so an approval revoked after staging never broadcasts. A spot staged without a topic (a
// listing spot) is unchanged. Lane 145G's lib/marketing/ctv-lane.ts calls stageCtvCampaign({ topicId, assetId, … }).

import { createServiceClient } from "@/lib/supabase/service"
import { VIBE_HOME_URL, dispatchCtvCampaign, type CtvDispatchResult } from "@/lib/providers/vibe"
import { GROUNDTRUTH_HOME_URL } from "@/lib/providers/groundtruth-ads"
import { STACKADAPT_HOME_URL } from "@/lib/providers/stackadapt-ads"
import { VIDEO_FINISHED_STATUSES } from "@/lib/video/video-status"
import { classifyPublicVideo } from "@/lib/video/public-video"
import { tvSpotOf, TV_SPOT_SPEC } from "@/lib/video/tv-spot"
import { TV_AD_CAMPAIGN_PLATFORMS } from "@/lib/integrations/ad-campaign-vocabulary"

// ─── THE TV CONNECTIONS (wave 146, lane 146E — owner ruling 8, 2026-10-29) ─────────────────────────────────
// "groundtruth (https://api-docs.groundtruth.com/) and stackadapt are 2 tv connections." They are ADAPTERS on this
// ONE gateway, not a second TV subsystem: the same staging (approved public video, the TV judge, the approved topic),
// the same broadcast gate at the authoritative write (ensureCtvBroadcastReady) and the same human launch approval;
// only the provider the staged row names differs. vibe_ctv stays the default and its launch path is unchanged.
// The provider-side facts each one publishes live beside its connector (lib/providers/groundtruth-ads.ts
// GROUNDTRUTH_DECLARATION, lib/providers/stackadapt-ads.ts STACKADAPT_DECLARATION).
export const CTV_TV_PLATFORMS = TV_AD_CAMPAIGN_PLATFORMS
export type CtvTvPlatform = (typeof CTV_TV_PLATFORMS)[number]
function isCtvTvPlatform(p: unknown): p is CtvTvPlatform {
  return typeof p === "string" && (CTV_TV_PLATFORMS as readonly string[]).includes(p)
}
/** Where a human finishes or inspects a spot on each TV connection (the launch package's link). */
const TV_PROVIDER_HOME: Readonly<Record<CtvTvPlatform, { label: string; url: string }>> = Object.freeze({
  vibe_ctv: { label: "Vibe", url: VIBE_HOME_URL },
  groundtruth: { label: "GroundTruth", url: GROUNDTRUTH_HOME_URL },
  stackadapt: { label: "StackAdapt", url: STACKADAPT_HOME_URL },
})

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface CtvTargeting {
  /** Nielsen DMA names/codes, e.g. "Sacramento-Stockton-Modesto". */
  dmas?: string[]
  cities?: string[]
  zips?: string[]
}

export interface StageCtvCampaignInput {
  brokerageId: string
  agentUserId: string
  listingId?: string | null
  /** ai_video_projects.id of the creative. When omitted, the newest eligible
   *  completed video for the listing (listingId required) is used. */
  videoProjectId?: string | null
  /** Contract C5 (wave 145): the creative ASSET — the same ai_video_projects.id under the contract's name. When both
   *  are given they must agree (one creative per spot). */
  assetId?: string | null
  /** Contract C5 (wave 145): the content_topic_bank topic this spot is made from. Must be APPROVED for TV by a person
   *  of this tenant (approvedTopicForTv); refused otherwise. Omitted = a listing / video spot, unchanged. */
  topicId?: string | null
  campaignName?: string
  dailyBudgetCents: number
  targeting: CtvTargeting
  /** Wave 146 (ruling 8): WHICH TV connection runs the spot — vibe_ctv (default), groundtruth or stackadapt. */
  tvPlatform?: CtvTvPlatform | null
  /** Wave 146: the CPM bid in USD a GroundTruth / StackAdapt launch needs (both bid per thousand impressions; a 0 bid
   *  never delivers). Recorded on the staged row; Vibe ignores it. */
  bidCpmUsd?: number | null
  /** The caller's client (the autonomous staging passes its own; default the service client). */
  client?: ReturnType<typeof createServiceClient>
}

export interface CtvLaunchPackage {
  campaignId: string
  /** The TV connection the spot is staged on (wave 146). */
  tvPlatform: CtvTvPlatform
  /** The provider's own home link (named vibeDeepLink before the second and third TV connection existed; the
   *  field keeps its name for the lane UI and carries the STAGED provider's link). */
  vibeDeepLink: string
  creativeUrl: string
  creativeDurationSeconds: number | null
  targetingSummary: string
  budgetSummary: string
  /** Real steps a human performs to launch on vibe.co — not an API simulation. */
  checklist: string[]
  /** Honest caveats (e.g. aspect ratio not recorded so it could not be verified). */
  warnings: string[]
}

export interface StageCtvCampaignResult {
  success: boolean
  error?: string
  package?: CtvLaunchPackage
}

// ─── THE TOPIC GATE (contract C5) — a topic spot broadcasts only on a topic a person approved ─────────────

/**
 * The approval_items.item_type values that mean "a person approved this topic for a TV spot". `ctv_topic` is the TV
 * approval lane 145G files from the topic bank (lib/marketing/ctv-lane.ts); `local_campaign_idea` is local-intel's
 * existing approval of a campaign idea built on a verified local fact (lib/content-intel/local-intel.ts
 * proposeLocalCampaignIdeas — its brief already names a 30-60 s video). Published so the filer and this gate speak ONE
 * vocabulary (CLAUDE.md §6). A data constant: nothing here is guessed from a title or a score.
 */
export const CTV_TOPIC_APPROVAL_ITEM_TYPES = ["ctv_topic", "local_campaign_idea"] as const

type TopicApproval =
  | { ok: true; topicId: string; title: string; approvalItemId: string; approvedAt: string | null; warnings: string[] }
  | { ok: false; reason: string }

type ApprovalRow = { id: string; item_type: string; status: string | null; reviewed_at: string | null; submitted_at: string | null }

/**
 * Is this topic APPROVED FOR TV for this tenant? Reads the topic (this tenant's, or a platform topic with no tenant —
 * the same visibility the topic picker uses, lib/content-intel/topic-bank.ts pickTopics) and the tenant's approval
 * items for it; the LATEST decision (approved / rejected, by reviewed_at) wins — a later rejection revokes an earlier
 * approval, a pending item decides nothing. FAIL CLOSED: a refused read is a refusal with its reason (§3, §4).
 * An expired freshness window is a WARNING (a person approved it; the fact may have moved), never a silent pass.
 */
async function approvedTopicForTv(
  svc: ReturnType<typeof createServiceClient>, brokerageId: string, topicId: string, now: Date = new Date(),
): Promise<TopicApproval> {
  if (!brokerageId || !topicId) return { ok: false, reason: "topic and tenant required" }
  const { data: t, error } = await svc
    .from("content_topic_bank").select("id, brokerage_id, topic_title, status, expires_at")
    .eq("id", topicId).maybeSingle()
  if (error) return { ok: false, reason: `content_topic_bank read refused: ${error.message}` }
  const topic = t as { id: string; brokerage_id: string | null; topic_title: string | null; status: string | null; expires_at: string | null } | null
  if (!topic || (topic.brokerage_id !== null && topic.brokerage_id !== brokerageId)) {
    return { ok: false, reason: "topic not found in this brokerage's topic bank" }
  }
  if (topic.status === "rejected") return { ok: false, reason: "the topic was rejected in the topic bank" }
  const { data: rows, error: apErr } = await svc
    .from("approval_items").select("id, item_type, status, reviewed_at, submitted_at")
    .eq("brokerage_id", brokerageId).eq("item_id", topicId)
    .in("item_type", [...CTV_TOPIC_APPROVAL_ITEM_TYPES]).limit(50)
  if (apErr) return { ok: false, reason: `approval_items read refused: ${apErr.message}` }
  const at = (r: ApprovalRow) => Date.parse(r.reviewed_at ?? r.submitted_at ?? "") || 0
  const decided = ((rows ?? []) as ApprovalRow[]).filter((r) => r.status === "approved" || r.status === "rejected").sort((a, b) => at(b) - at(a))
  const latest = decided[0]
  if (!latest) {
    return { ok: false, reason: `not approved for TV — no person has approved this topic (approval_items ${CTV_TOPIC_APPROVAL_ITEM_TYPES.join(" / ")}, status approved)` }
  }
  if (latest.status !== "approved") return { ok: false, reason: "not approved for TV — the latest decision on this topic is a rejection" }
  const warnings: string[] = []
  const expires = topic.expires_at ? Date.parse(topic.expires_at) : NaN
  if (Number.isFinite(expires) && expires < now.getTime()) {
    warnings.push(`The topic's freshness window ended ${String(topic.expires_at).slice(0, 10)} — confirm the market fact it carries still holds before launch.`)
  }
  return { ok: true, topicId: topic.id, title: (topic.topic_title ?? "").trim(), approvalItemId: latest.id, approvedAt: latest.reviewed_at, warnings }
}

// ─── CREATIVE VALIDATION (pure) ──────────────────────────────────────────────

/** Standard CTV spot lengths the lane accepts, with tolerance for encoder drift. */
const CTV_SPOT_LENGTHS_SECONDS = [15, 30] as const
const CTV_DURATION_TOLERANCE_SECONDS = 2

interface CreativeFacts {
  videoUrl: string | null
  durationSeconds: number | null
  /** ai_video_projects.format free text — "16:9" | "9:16" | "1:1" | other/null. */
  format: string | null
  status: string | null
}

interface CtvCreativeCheck {
  ok: boolean
  /** Hard failures — the video cannot run as a CTV spot. */
  reasons: string[]
  /** Soft caveats — facts we could not verify from recorded metadata. */
  warnings: string[]
}

const LANDSCAPE_FORMATS = ["16:9", "horizontal", "landscape"]
const NON_LANDSCAPE_FORMATS = ["9:16", "1:1", "vertical", "square", "portrait"]

/** The CTV checks we CAN honestly run from recorded metadata. Anything we
 *  cannot verify becomes a warning + checklist item, never a fabricated pass. */
// Module-private since 2026-09-08 — no importer outside this file (category B tranche).
function validateCtvCreative(facts: CreativeFacts): CtvCreativeCheck {
  const reasons: string[] = []
  const warnings: string[] = []

  // 'published' is POST-terminal and still means a rendered asset exists, so a
  // distributed video is as eligible for TV as a merely completed one.
  if (!facts.status || !(VIDEO_FINISHED_STATUSES as readonly string[]).includes(facts.status)) {
    reasons.push(`video is not finished (status '${facts.status ?? "unknown"}') — only a fully rendered video can run on TV`)
  }
  if (!facts.videoUrl) {
    reasons.push("video has no rendered video_url — nothing to upload to Vibe")
  }

  if (facts.durationSeconds == null) {
    warnings.push("duration_seconds is not recorded — confirm the spot is exactly 15s or 30s before uploading")
  } else {
    const nearSpot = CTV_SPOT_LENGTHS_SECONDS.some(
      (spot) => Math.abs(facts.durationSeconds! - spot) <= CTV_DURATION_TOLERANCE_SECONDS,
    )
    if (!nearSpot) {
      reasons.push(
        `duration ${facts.durationSeconds}s is not a standard CTV spot length (${CTV_SPOT_LENGTHS_SECONDS.join("s/")}s ±${CTV_DURATION_TOLERANCE_SECONDS}s) — re-cut the video to 15s or 30s`,
      )
    }
  }

  const fmt = (facts.format ?? "").trim().toLowerCase()
  if (NON_LANDSCAPE_FORMATS.includes(fmt)) {
    reasons.push(`format '${facts.format}' is not 16:9 — TV screens need a landscape (16:9) cut; render a horizontal version`)
  } else if (!LANDSCAPE_FORMATS.includes(fmt)) {
    warnings.push("aspect ratio is not recorded as 16:9 — verify the video is landscape 16:9 before uploading")
  }

  return { ok: reasons.length === 0, reasons, warnings }
}

// ─── THE BROADCAST CREATIVE (pure) — the judge's verdict, read, not re-spelled ─

/** The ai_video_projects columns the broadcast verdict reads. */
const BROADCAST_VIDEO_COLUMNS = "id, title, status, video_url, duration_seconds, format, listing_id, video_type, audience_type, usage_intent, contact_id, learning_module_id, approval_status, compliance_status, video_metadata"

type BroadcastVideoRow = {
  id: string; title: string | null; status: string | null; video_url: string | null; duration_seconds: number | null; format: string | null; listing_id: string | null
  video_type?: string | null; audience_type?: string | null; usage_intent?: string | null; contact_id?: string | null; learning_module_id?: string | null
  approval_status?: string | null; compliance_status?: string | null; video_metadata?: unknown
}

type CtvBroadcastCreative =
  | { ok: true; source: "tv_master"; url: string; specVersion: string; warnings: string[] }
  | { ok: true; source: "social_master_unverified"; url: string; warnings: string[] }
  | { ok: false; reason: string }

/**
 * PURE. Which file may go on TV. `requireMaster` is true at LAUNCH (the broadcast) and false at STAGING (a draft):
 * a staged draft may carry the social master with the gap said; nothing reaches Vibe without a READY TV master.
 */
function ctvBroadcastCreative(row: BroadcastVideoRow, opts: { requireMaster: boolean }): CtvBroadcastCreative {
  const verdict = classifyPublicVideo(row)
  if (!verdict.public) {
    return { ok: false, reason: `not an approved public marketing video (${verdict.reason.replace(/_/g, " ")}) — a TV ad is a broadcast, so a client's, personal, unapproved, MLS-only or in-house video never runs on TV` }
  }
  const tv = tvSpotOf(row.video_metadata)
  if (tv && tv.ready) return { ok: true, source: "tv_master", url: tv.url, specVersion: tv.spec_version, warnings: [...tv.warnings] }
  if (tv && !tv.ready) {
    const failed = tv.checks.filter((c) => !c.ok)
    return { ok: false, reason: `the TV master is NOT ready — failed ${failed.map((c) => `${c.id} (needs ${c.required}, measured ${c.measured})`).join("; ")}. Fix the cut and make the TV master again` }
  }
  if (opts.requireMaster) {
    return { ok: false, reason: `no TV master has been made for this video yet — make the TV master (${TV_MASTER_SUMMARY}) and launch once it reads READY; the social reel is never sent to TV` }
  }
  return { ok: true, source: "social_master_unverified", url: String(row.video_url ?? ""), warnings: ["No TV master yet — this draft carries the social reel. Make the TV master (Video → TV master) before launch: the launch is refused until a READY master exists."] }
}

/** What a TV master is, in words — DERIVED from the judge's spec, never re-spelled. */
const TV_MASTER_SUMMARY = `${TV_SPOT_SPEC.width}×${TV_SPOT_SPEC.height}, ${TV_SPOT_SPEC.loudness.targetLkfs} LKFS, captions`

/** The usage-rights line every TV launch package carries — the platform holds licence links, not their broadcast scope. */
const CTV_RIGHTS_CHECK = "Usage rights: confirm the music bed, b-roll and any stock footage in this spot are licensed for streaming-TV broadcast (many social licences exclude broadcast). The platform records each music asset's licence link and attribution, not the scope of the licence."

// ─── SUMMARIES (pure) ────────────────────────────────────────────────────────

function normalizeList(list?: string[]): string[] {
  return (list ?? []).map((s) => s.trim()).filter(Boolean)
}

// Module-private since 2026-09-08 — no importer outside this file (category B tranche).
function summarizeCtvTargeting(t: CtvTargeting): string {
  const parts: string[] = []
  const dmas = normalizeList(t.dmas)
  const cities = normalizeList(t.cities)
  const zips = normalizeList(t.zips)
  if (dmas.length) parts.push(`DMAs: ${dmas.join(", ")}`)
  if (cities.length) parts.push(`Cities: ${cities.join(", ")}`)
  if (zips.length) parts.push(`ZIPs: ${zips.join(", ")}`)
  return parts.join(" · ")
}

// Module-private since 2026-09-08 — no importer outside this file (category B tranche).
function summarizeCtvBudget(dailyBudgetCents: number): string {
  return `$${(dailyBudgetCents / 100).toFixed(2)}/day`
}

// ─── STAGE ───────────────────────────────────────────────────────────────────

/**
 * Stage a streaming-TV campaign: validate the creative, write the
 * ad_campaigns row (platform='vibe_ctv', status='draft'), and return the
 * launch package. The row is a REAL draft — nothing here talks to Vibe.
 */
export async function stageCtvCampaign(input: StageCtvCampaignInput): Promise<StageCtvCampaignResult> {
  const { brokerageId, agentUserId, listingId, dailyBudgetCents, targeting } = input
  if (input.assetId && input.videoProjectId && input.assetId !== input.videoProjectId) {
    return { success: false, error: "assetId and videoProjectId disagree — a spot carries ONE creative; pass one of them" }
  }
  const videoProjectId = input.assetId ?? input.videoProjectId ?? null

  if (!brokerageId || !agentUserId) {
    return { success: false, error: "brokerageId and agentUserId required" }
  }
  if (!Number.isFinite(dailyBudgetCents) || Math.round(dailyBudgetCents) <= 0) {
    return { success: false, error: "dailyBudgetCents must be a positive amount" }
  }
  const dmas = normalizeList(targeting.dmas)
  const cities = normalizeList(targeting.cities)
  const zips = normalizeList(targeting.zips)
  if (dmas.length + cities.length + zips.length === 0) {
    return { success: false, error: "Targeting requires at least one DMA, city, or ZIP" }
  }
  if (!videoProjectId && !listingId) {
    return { success: false, error: "Pick a video (videoProjectId) or a listing to source one from" }
  }
  const tvPlatform: CtvTvPlatform = input.tvPlatform ?? "vibe_ctv"
  if (!isCtvTvPlatform(tvPlatform)) {
    return { success: false, error: `'${String(input.tvPlatform)}' is not a TV connection (${CTV_TV_PLATFORMS.join(", ")})` }
  }
  const bidCpmUsd = input.bidCpmUsd == null ? null : Number(input.bidCpmUsd)
  if (bidCpmUsd != null && !(Number.isFinite(bidCpmUsd) && bidCpmUsd > 0)) {
    return { success: false, error: "bidCpmUsd must be a positive CPM in USD" }
  }
  if (tvPlatform !== "vibe_ctv" && bidCpmUsd == null) {
    return { success: false, error: `${TV_PROVIDER_HOME[tvPlatform].label} bids per thousand impressions — give the CPM bid (bidCpmUsd) when staging` }
  }

  const supabase = input.client ?? createServiceClient()

  // ── The topic gate (contract C5): a topic spot stages only on a topic a person approved for TV ──
  let topic: Extract<TopicApproval, { ok: true }> | null = null
  if (input.topicId) {
    const t = await approvedTopicForTv(supabase, brokerageId, input.topicId)
    if (!t.ok) return { success: false, error: `TV topic refused: ${t.reason}` }
    topic = t
  }

  // ── Load the creative (explicit pick, or newest eligible for the listing) ──
  let videoQuery = supabase
    .from("ai_video_projects")
    .select(BROADCAST_VIDEO_COLUMNS)
    .eq("brokerage_id", brokerageId)
  videoQuery = videoProjectId
    ? videoQuery.eq("id", videoProjectId)
    : videoQuery.eq("listing_id", listingId!).in("status", [...VIDEO_FINISHED_STATUSES]).not("video_url", "is", null)
  const { data: videos, error: videoError } = await videoQuery
    .order("created_at", { ascending: false })
    .limit(1)
  if (videoError) {
    return { success: false, error: `Video lookup failed: ${videoError.message}` }
  }
  const video = videos?.[0] as BroadcastVideoRow | undefined
  if (!video) {
    return {
      success: false,
      error: videoProjectId
        ? "Video not found in this brokerage"
        : "No completed video with a rendered URL exists for this listing — produce one in the Marketing Studio first",
    }
  }

  // ── The broadcast gate + the TV judge's verdict (lib/video/tv-spot.ts) ─────
  const broadcast = ctvBroadcastCreative(video, { requireMaster: false })
  if (!broadcast.ok) {
    return { success: false, error: `Creative is not TV-ready: ${broadcast.reason}` }
  }

  // ── The CTV checks we CAN run ──────────────────────────────────────────────
  // A READY master is 16:9 by the judge's measurement; the social reel's format is only what was recorded.
  const check = validateCtvCreative({
    videoUrl: broadcast.url || null,
    durationSeconds: video.duration_seconds,
    format: broadcast.source === "tv_master" ? "16:9" : video.format,
    status: video.status,
  })
  if (!check.ok) {
    return { success: false, error: `Creative is not TV-ready: ${check.reasons.join("; ")}` }
  }
  const warnings = [...broadcast.warnings, ...check.warnings, ...(topic?.warnings ?? [])]

  const targetingSummary = summarizeCtvTargeting({ dmas, cities, zips })
  const budgetSummary = summarizeCtvBudget(dailyBudgetCents)
  const campaignName =
    input.campaignName?.trim() || `Streaming TV — ${video.title?.trim() || "listing spot"}`

  // ── Stage the draft row ────────────────────────────────────────────────────
  const { data: campaign, error: insertError } = await supabase
    .from("ad_campaigns")
    .insert({
      brokerage_id: brokerageId,
      agent_user_id: agentUserId,
      created_by: agentUserId,
      campaign_name: campaignName,
      platform: tvPlatform,
      objective: "awareness",
      status: "draft",
      daily_budget: Math.round(dailyBudgetCents) / 100,
      targeting_config: {
        play: "ctv",
        ...(bidCpmUsd != null ? { bid_cpm_usd: bidCpmUsd } : {}),
        dmas,
        cities,
        zips,
        creative_video_url: broadcast.url,
        creative_source: broadcast.source,
        tv_spot_spec_version: broadcast.source === "tv_master" ? broadcast.specVersion : null,
        creative_duration: video.duration_seconds,
        video_project_id: video.id,
        listing_id: listingId ?? video.listing_id ?? null,
        // Contract C5 provenance — what the spot is about and WHO approved it (re-checked at launch).
        ...(topic ? { topic_id: topic.topicId, topic_title: topic.title || null, topic_approval_item_id: topic.approvalItemId, topic_approved_at: topic.approvedAt } : {}),
      },
      visibility_scope: "agent",
    })
    .select("id")
    .maybeSingle()

  if (insertError) {
    // Tolerate the pre-migration platform CHECK (facebook/instagram/google):
    // surface the honest reason + the exact migration instead of a cryptic 23514.
    const msg = insertError.message ?? ""
    if (insertError.code === "23514" || /platform.*check|check.*platform/i.test(msg)) {
      const migration = tvPlatform === "vibe_ctv" ? "m271-ad-campaigns-vibe-ctv-platform.sql" : "m881-tv-connections-groundtruth-stackadapt.sql"
      return {
        success: false,
        error:
          `Database rejected platform '${tvPlatform}' (${msg}). The ad_campaigns.platform CHECK has not been widened yet — apply supabase/migrations/${migration}, then stage again.`,
      }
    }
    return { success: false, error: `Failed to stage campaign: ${msg}` }
  }
  if (!campaign?.id) {
    return { success: false, error: "Failed to stage campaign: no row returned" }
  }

  // ── Launch package — the real steps a human runs on the provider ───────────
  const durationLabel = video.duration_seconds != null ? `${video.duration_seconds}s` : "15s/30s"
  const provider = TV_PROVIDER_HOME[tvPlatform]
  const checklist = [
    tvPlatform === "vibe_ctv"
      ? `Sign in at vibe.co with the brokerage's Vibe account (create one if this is the first streaming-TV campaign).`
      : `Connect the brokerage's ${provider.label} account in Settings → Connections (${provider.label} issues API credentials on request) — the in-app launch runs the same TV gate and is refused until it is connected.`,
    broadcast.source === "tv_master"
      ? `Create a new campaign in ${provider.label} and upload the TV MASTER (${durationLabel}, ${TV_MASTER_SUMMARY}; spec ${broadcast.specVersion}): ${broadcast.url}`
      : `Make the TV master first (Video → TV master) — then upload THAT file, never the social reel. The launch here is refused until it reads READY.`,
    ...(topic ? [`Topic: "${topic.title || topic.topicId}" — approved for TV${topic.approvedAt ? ` on ${topic.approvedAt.slice(0, 10)}` : ""}; the spot's claims must match the topic's source.`] : []),
    `Set geographic targeting to: ${targetingSummary}.`,
    `Set the daily budget to ${budgetSummary} — confirm it meets ${provider.label}'s current platform minimum before launching.`,
    ...(bidCpmUsd != null ? [`CPM bid: $${bidCpmUsd.toFixed(2)} per thousand impressions.`] : []),
    `Real-estate compliance: keep targeting Fair-Housing-safe — geography only, no demographic narrowing.`,
    CTV_RIGHTS_CHECK,
    `Launch on ${provider.label}, then return to the Ads Manager Streaming TV lane and press "Mark as launched" so this campaign leaves draft.`,
    ...warnings.map((w) => `Verify before upload: ${w}`),
  ]

  return {
    success: true,
    package: {
      campaignId: campaign.id,
      tvPlatform,
      vibeDeepLink: provider.url,
      creativeUrl: broadcast.url,
      creativeDurationSeconds: video.duration_seconds,
      targetingSummary,
      budgetSummary,
      checklist,
      warnings,
    },
  }
}

// ─── LAUNCH ON VIBE — the one place a CTV row leaves draft by API ────────────
//
// dispatch (lib/providers/vibe.ts) + flip the row + ledger the launch. The
// server action app/actions/ctv-ads.ts::dispatchCtvCampaignAction and the Ads
// Manager executor (lib/ads/ad-manager.ts launch_ad_campaign, platform vibe_ctv)
// both call THIS; neither re-spells the flip. No fake live state: the row moves
// only on a Vibe-confirmed PUBLISHED campaign.

export interface LaunchCtvInput {
  campaignId: string
  brokerageId: string
  /** The human whose approval launched it (null when the Ads Manager ran an
   *  approved action — the approver is on ad_manager_actions). */
  actorUserId: string | null
  launchedVia: "vibe_api" | "ads_manager"
  client?: ReturnType<typeof createServiceClient>
}

export async function launchCtvCampaignOnVibe(input: LaunchCtvInput): Promise<CtvDispatchResult> {
  const svc = input.client ?? createServiceClient()
  const { data: campaign, error } = await svc
    .from("ad_campaigns").select("id, targeting_config, status")
    .eq("id", input.campaignId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (error) return { dispatched: false, reason: `campaign read refused: ${error.message}` }
  if (!campaign) return { dispatched: false, reason: "Campaign not found in this brokerage" }
  if (["live", "launching"].includes(String(campaign.status))) {
    return { dispatched: false, reason: `campaign is already ${campaign.status}` }
  }
  // THE BROADCAST GATE AT THE AUTHORITATIVE WRITE: an approved public video with a READY TV master, or no launch.
  const broadcast = await ensureCtvBroadcastReady({ campaignId: input.campaignId, brokerageId: input.brokerageId, client: svc })
  if (!broadcast.ok) return { dispatched: false, reason: `not launched — ${broadcast.reason}` }

  const result = await dispatchCtvCampaign(input.campaignId)
  if (!(result.dispatched && result.vibeCampaignId)) return result

  const nowIso = new Date().toISOString()
  // `external_campaign_id` is the ONE key every platform's ingest reads
  // (lib/ads/ad-performance-ingest.ts); the vibe_* ids are the provider's own.
  const { data: flipped, error: flipError } = await svc
    .from("ad_campaigns")
    .update({
      status: "live",
      updated_at: nowIso,
      targeting_config: {
        ...((campaign.targeting_config as Record<string, unknown>) ?? {}),
        launched_via: input.launchedVia,
        launched_at: nowIso,
        external_campaign_id: result.vibeCampaignId,
        vibe_campaign_id: result.vibeCampaignId,
        vibe_strategy_id: result.vibeStrategyId ?? null,
        vibe_creative_id: result.vibeCreativeId ?? null,
      },
    })
    .eq("id", input.campaignId).eq("brokerage_id", input.brokerageId)
    .select("id")
  // An UPDATE matching nothing also resolves (§3): count what came back.
  if (flipError || !flipped?.length) {
    return { ...result, reason: `Published on Vibe (${result.vibeCampaignId}) but the row did NOT flip to live: ${flipError?.message ?? "no row matched"} — mark it launched by hand` }
  }
  const kernelEmit = await import("@/lib/kernel/emit")
  const { error: eventError } = kernelEmit.asWriteResult(await kernelEmit.emitKernelEvent({
    brokerageId: input.brokerageId,
    entityType: "ad_campaign",
    entityId: input.campaignId,
    event: "ad_campaign_launched",
    actorUserId: input.actorUserId,
    metadata: { platform: "vibe_ctv", launched_via: input.launchedVia, vibe_campaign_id: result.vibeCampaignId },
    auditOnly: true,
  }))
  if (eventError) console.error("[ctv-campaign] launch ledger refused:", eventError.message)
  return result
}

// ─── THE BROADCAST GATE — shared by both launch doors ────────────────────────
//
// launchCtvCampaignOnVibe (the server action + the Ads Manager executor) and the
// ad-connector registry's publish (lib/ads/connectors/vibe-ctv.ts) both run THIS
// before lib/providers/vibe.ts dispatchCtvCampaign reads the staged row: it
// re-reads the campaign's video (tenant-pinned), applies the broadcast verdict
// with a READY master REQUIRED, and points the row's creative_video_url at the
// TV master (a COUNTED update, §3) so the provider uploads the master, never the
// social reel. Fail closed: an unreadable row is a refusal, not a pass.

export async function ensureCtvBroadcastReady(input: {
  campaignId: string
  brokerageId: string
  client?: ReturnType<typeof createServiceClient>
}): Promise<{ ok: true; creativeUrl: string } | { ok: false; reason: string }> {
  if (!input.campaignId || !input.brokerageId) return { ok: false, reason: "campaign and tenant required" }
  const svc = input.client ?? createServiceClient()
  const { data: c, error } = await svc
    .from("ad_campaigns").select("id, platform, targeting_config")
    .eq("id", input.campaignId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (error) return { ok: false, reason: `campaign read refused: ${error.message}` }
  const campaign = c as { id: string; platform: string; targeting_config: Record<string, unknown> | null } | null
  if (!campaign) return { ok: false, reason: "campaign not found in this brokerage" }
  // Every TV connection rides THIS gate (wave 146, ruling 8): vibe_ctv, groundtruth, stackadapt — nothing else.
  if (!isCtvTvPlatform(campaign.platform)) return { ok: false, reason: `campaign platform is '${campaign.platform}', not a TV connection (${CTV_TV_PLATFORMS.join(", ")})` }
  const cfg = campaign.targeting_config ?? {}
  // Contract C5: a TOPIC spot re-reads its approval at the authoritative write — an approval revoked (or a topic
  // rejected) after staging never broadcasts. Both launch doors run this gate.
  const topicId = typeof cfg.topic_id === "string" && cfg.topic_id ? cfg.topic_id : null
  if (topicId) {
    const t = await approvedTopicForTv(svc, input.brokerageId, topicId)
    if (!t.ok) return { ok: false, reason: `the campaign's topic is no longer approved for TV (${t.reason}) — a topic spot broadcasts only on an approved topic` }
  }
  const videoId = typeof cfg.video_project_id === "string" ? cfg.video_project_id : null
  if (!videoId) return { ok: false, reason: "the staged campaign names no video project — stage it again from the video" }
  const { data: v, error: vErr } = await svc
    .from("ai_video_projects").select(BROADCAST_VIDEO_COLUMNS)
    .eq("id", videoId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (vErr) return { ok: false, reason: `video read refused: ${vErr.message}` }
  if (!v) return { ok: false, reason: "the campaign's video is not in this brokerage" }
  const verdict = ctvBroadcastCreative(v as BroadcastVideoRow, { requireMaster: true })
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  if (cfg.creative_video_url !== verdict.url || cfg.creative_source !== "tv_master") {
    const specVersion = verdict.source === "tv_master" ? verdict.specVersion : null
    const { data: moved, error: moveErr } = await svc
      .from("ad_campaigns")
      .update({ targeting_config: { ...cfg, creative_video_url: verdict.url, creative_source: verdict.source, tv_spot_spec_version: specVersion }, updated_at: new Date().toISOString() })
      .eq("id", input.campaignId).eq("brokerage_id", input.brokerageId)
      .select("id")
    if (moveErr || !moved?.length) return { ok: false, reason: `the TV master could not be set as the creative: ${moveErr?.message ?? "no row matched"}` }
  }
  return { ok: true, creativeUrl: verdict.url }
}

// ─── LAUNCH ON ANY TV CONNECTION — the one router (wave 146, lane 146E — ruling 8) ─────────────────────
//
// The action door (app/actions/ctv-ads.ts dispatchCtvCampaignAction) and the Ads Manager executor
// (lib/ads/ad-manager.ts launch_ad_campaign) call THIS for a staged TV row. vibe_ctv goes to its existing path
// (launchCtvCampaignOnVibe — unchanged); groundtruth / stackadapt go through the ONE ad-connector registry, whose
// publish runs ensureCtvBroadcastReady before the provider is asked. The row flips to live ONLY on the provider's
// confirmation, counted (§3), with the provider id as external_campaign_id (the key the performance ingest reads).

export interface TvLaunchResult { dispatched: boolean; reason: string; externalCampaignId?: string; platform?: CtvTvPlatform }

export async function launchTvCampaign(input: Omit<LaunchCtvInput, "launchedVia"> & { launchedVia: "provider_api" | "ads_manager" }): Promise<TvLaunchResult> {
  const svc = input.client ?? createServiceClient()
  const { data: campaign, error } = await svc
    .from("ad_campaigns").select("id, platform, targeting_config, status")
    .eq("id", input.campaignId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (error) return { dispatched: false, reason: `campaign read refused: ${error.message}` }
  const row = campaign as { id: string; platform: string; targeting_config: Record<string, unknown> | null; status: string } | null
  if (!row) return { dispatched: false, reason: "Campaign not found in this brokerage" }
  if (!isCtvTvPlatform(row.platform)) return { dispatched: false, reason: `campaign platform is '${row.platform}', not a TV connection` }
  if (row.platform === "vibe_ctv") {
    const r = await launchCtvCampaignOnVibe({ campaignId: input.campaignId, brokerageId: input.brokerageId, actorUserId: input.actorUserId, launchedVia: input.launchedVia === "ads_manager" ? "ads_manager" : "vibe_api", client: svc })
    return { dispatched: r.dispatched, reason: r.reason, externalCampaignId: r.vibeCampaignId, platform: "vibe_ctv" }
  }
  if (["live", "launching"].includes(String(row.status))) return { dispatched: false, reason: `campaign is already ${row.status}`, platform: row.platform }

  const { getConnector, loadConnectorCredential } = await import("@/lib/ads/connectors/registry")
  const connector = getConnector(row.platform)
  if (!connector) return { dispatched: false, reason: `no connector for '${row.platform}'`, platform: row.platform }
  const cred = await loadConnectorCredential(input.brokerageId, row.platform, svc)
  if (!cred) return { dispatched: false, reason: `${TV_PROVIDER_HOME[row.platform].label} is not connected — the spot stays staged; connect it in Settings → Connections`, platform: row.platform }
  const pub = await connector.publishCampaign({ structure: { campaign_id: input.campaignId }, cred })
  if (!pub.ok || !pub.externalCampaignId) return { dispatched: false, reason: pub.error ?? "the provider returned no campaign id", platform: row.platform }

  // Re-read the row: the gate may have pointed creative_video_url at the TV master (a counted update of its own).
  const { data: fresh, error: freshErr } = await svc.from("ad_campaigns").select("targeting_config").eq("id", input.campaignId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (freshErr) console.error("[ctv-campaign] post-publish re-read refused — flipping on the staged config:", freshErr.message)
  const cfg = ((fresh as { targeting_config?: Record<string, unknown> | null } | null)?.targeting_config ?? row.targeting_config ?? {}) as Record<string, unknown>
  const nowIso = new Date().toISOString()
  const { data: flipped, error: flipError } = await svc
    .from("ad_campaigns")
    .update({ status: "live", updated_at: nowIso, targeting_config: { ...cfg, launched_via: input.launchedVia, launched_at: nowIso, external_campaign_id: pub.externalCampaignId } })
    .eq("id", input.campaignId).eq("brokerage_id", input.brokerageId)
    .select("id")
  if (flipError || !flipped?.length) {
    return { dispatched: true, externalCampaignId: pub.externalCampaignId, platform: row.platform, reason: `Submitted to ${TV_PROVIDER_HOME[row.platform].label} (${pub.externalCampaignId}) but the row did NOT flip to live: ${flipError?.message ?? "no row matched"} — mark it launched by hand` }
  }
  const kernelEmit = await import("@/lib/kernel/emit")
  const { error: eventError } = kernelEmit.asWriteResult(await kernelEmit.emitKernelEvent({
    brokerageId: input.brokerageId, entityType: "ad_campaign", entityId: input.campaignId, event: "ad_campaign_launched", actorUserId: input.actorUserId,
    metadata: { platform: row.platform, launched_via: input.launchedVia, external_campaign_id: pub.externalCampaignId }, auditOnly: true,
  }))
  if (eventError) console.error("[ctv-campaign] launch ledger refused:", eventError.message)
  return { dispatched: true, externalCampaignId: pub.externalCampaignId, platform: row.platform, reason: `Submitted to ${TV_PROVIDER_HOME[row.platform].label} (${pub.externalCampaignId})` }
}

// ─── AUTONOMOUS STAGING — a finished promotable video becomes a TV draft ─────
//
// The Asset Manager raises `ads_manager:video_ready` for just_listed /
// just_sold / open_house renders (lib/kernel/video-coordination.ts), which
// lib/kernel/manager-signals.ts turns into a `launch_ad_campaign` proposal that
// carries ONLY a video_project_id. The executor needs a campaign; this stages
// it — geography from the listing (its ZIP and city) or the brokerage's city,
// budget at the lane's autonomous default — so the approved proposal can go
// straight to Vibe. Idempotent per video.

/** Autonomous default. Clamped by MAX_AD_DAILY_BUDGET_USD at execution. */
export const CTV_AUTO_DAILY_BUDGET_USD = 25

export async function stageCtvCampaignForVideo(input: {
  brokerageId: string
  videoProjectId: string
  dailyBudgetUsd?: number
  client?: ReturnType<typeof createServiceClient>
}): Promise<{ ok: boolean; campaignId?: string; reason?: string; alreadyStaged?: boolean }> {
  const svc = input.client ?? createServiceClient()
  const { data: existing, error: existingError } = await svc
    .from("ad_campaigns").select("id")
    .eq("brokerage_id", input.brokerageId).eq("platform", "vibe_ctv")
    .contains("targeting_config", { video_project_id: input.videoProjectId })
    .limit(1).maybeSingle()
  if (existingError) return { ok: false, reason: `ad_campaigns read refused: ${existingError.message}` }
  if (existing) return { ok: true, campaignId: (existing as { id: string }).id, alreadyStaged: true }

  const { data: v, error: vError } = await svc
    .from("ai_video_projects").select("id, listing_id, agent_id")
    .eq("id", input.videoProjectId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (vError) return { ok: false, reason: `video read refused: ${vError.message}` }
  const video = v as { id: string; listing_id: string | null; agent_id: string | null } | null
  if (!video) return { ok: false, reason: "video not found in this brokerage" }

  // Geography: the listing's ZIP + city, else the brokerage's city. Never a
  // demographic (Fair Housing) — the same rule the manual lane enforces.
  const targeting: CtvTargeting = {}
  let agentRecordId: string | null = video.agent_id
  if (video.listing_id) {
    const { data: l } = await svc.from("listings").select("city, zip, agent_id").eq("id", video.listing_id).maybeSingle()
    const listing = l as { city: string | null; zip: string | null; agent_id: string | null } | null
    if (listing?.zip) targeting.zips = [listing.zip]
    if (listing?.city) targeting.cities = [listing.city]
    agentRecordId = agentRecordId ?? listing?.agent_id ?? null
  }
  if (!targeting.zips?.length && !targeting.cities?.length) {
    const { data: b } = await svc.from("brokerages").select("city").eq("id", input.brokerageId).maybeSingle()
    const city = (b as { city: string | null } | null)?.city
    if (city) targeting.cities = [city]
  }
  if (!targeting.zips?.length && !targeting.cities?.length) return { ok: false, reason: "no geography: the listing has no ZIP/city and the brokerage has no city" }

  // agents.id and users.id are DISJOINT (§3) — cross via the resolver.
  let agentUserId: string | null = null
  if (agentRecordId) {
    const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
    agentUserId = await resolveAgentRecordToUserId(agentRecordId)
  }
  if (!agentUserId) return { ok: false, reason: "no agent user to own the campaign (video and listing carry no resolvable agent)" }

  const staged = await stageCtvCampaign({
    brokerageId: input.brokerageId,
    agentUserId,
    listingId: video.listing_id,
    videoProjectId: video.id,
    dailyBudgetCents: Math.round((input.dailyBudgetUsd ?? CTV_AUTO_DAILY_BUDGET_USD) * 100),
    targeting,
    client: svc,
  })
  if (!staged.success || !staged.package) return { ok: false, reason: staged.error ?? "stage failed" }
  return { ok: true, campaignId: staged.package.campaignId }
}
