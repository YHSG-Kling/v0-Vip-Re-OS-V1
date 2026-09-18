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

import { createServiceClient } from "@/lib/supabase/service"
import { VIBE_HOME_URL, dispatchCtvCampaign, type CtvDispatchResult } from "@/lib/providers/vibe"
import { VIDEO_FINISHED_STATUSES } from "@/lib/video/video-status"

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
  campaignName?: string
  dailyBudgetCents: number
  targeting: CtvTargeting
}

export interface CtvLaunchPackage {
  campaignId: string
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
  const { brokerageId, agentUserId, listingId, videoProjectId, dailyBudgetCents, targeting } = input

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

  const supabase = createServiceClient()

  // ── Load the creative (explicit pick, or newest eligible for the listing) ──
  let videoQuery = supabase
    .from("ai_video_projects")
    .select("id, title, status, video_url, duration_seconds, format, listing_id")
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
  const video = videos?.[0] as
    | { id: string; title: string | null; status: string | null; video_url: string | null; duration_seconds: number | null; format: string | null; listing_id: string | null }
    | undefined
  if (!video) {
    return {
      success: false,
      error: videoProjectId
        ? "Video not found in this brokerage"
        : "No completed video with a rendered URL exists for this listing — produce one in the Marketing Studio first",
    }
  }

  // ── The CTV checks we CAN run ──────────────────────────────────────────────
  const check = validateCtvCreative({
    videoUrl: video.video_url,
    durationSeconds: video.duration_seconds,
    format: video.format,
    status: video.status,
  })
  if (!check.ok) {
    return { success: false, error: `Creative is not TV-ready: ${check.reasons.join("; ")}` }
  }

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
      platform: "vibe_ctv",
      objective: "awareness",
      status: "draft",
      daily_budget: Math.round(dailyBudgetCents) / 100,
      targeting_config: {
        play: "ctv",
        dmas,
        cities,
        zips,
        creative_video_url: video.video_url,
        creative_duration: video.duration_seconds,
        video_project_id: video.id,
        listing_id: listingId ?? video.listing_id ?? null,
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
      return {
        success: false,
        error:
          `Database rejected platform 'vibe_ctv' (${msg}). The ad_campaigns.platform CHECK has not been widened yet — apply supabase/migrations/m271-ad-campaigns-vibe-ctv-platform.sql, then stage again.`,
      }
    }
    return { success: false, error: `Failed to stage campaign: ${msg}` }
  }
  if (!campaign?.id) {
    return { success: false, error: "Failed to stage campaign: no row returned" }
  }

  // ── Launch package — the real steps a human runs on vibe.co ────────────────
  const durationLabel = video.duration_seconds != null ? `${video.duration_seconds}s` : "15s/30s"
  const checklist = [
    `Sign in at vibe.co with the brokerage's Vibe account (create one if this is the first streaming-TV campaign).`,
    `Create a new campaign in Vibe and upload the creative video (${durationLabel}, 16:9 MP4): ${video.video_url}`,
    `Set geographic targeting to: ${targetingSummary}.`,
    `Set the daily budget to ${budgetSummary} — confirm it meets Vibe's current platform minimum before launching.`,
    `Real-estate compliance: keep targeting Fair-Housing-safe — geography only, no demographic narrowing.`,
    `Launch on Vibe, then return to the Ads Manager Streaming TV lane and press "Mark as launched" so this campaign leaves draft.`,
    ...check.warnings.map((w) => `Verify before upload: ${w}`),
  ]

  return {
    success: true,
    package: {
      campaignId: campaign.id,
      vibeDeepLink: VIBE_HOME_URL,
      creativeUrl: video.video_url as string,
      creativeDurationSeconds: video.duration_seconds,
      targetingSummary,
      budgetSummary,
      checklist,
      warnings: check.warnings,
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
  const { error: eventError } = await svc.from("lifecycle_events").insert({
    brokerage_id: input.brokerageId,
    entity_type: "ad_campaign",
    entity_id: input.campaignId,
    event_type: "ad_campaign_launched",
    actor_user_id: input.actorUserId,
    metadata: { platform: "vibe_ctv", launched_via: input.launchedVia, vibe_campaign_id: result.vibeCampaignId },
  })
  if (eventError) console.error("[ctv-campaign] launch ledger refused:", eventError.message)
  return result
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
  })
  if (!staged.success || !staged.package) return { ok: false, reason: staged.error ?? "stage failed" }
  return { ok: true, campaignId: staged.package.campaignId }
}
