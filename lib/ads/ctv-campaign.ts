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
//   2. lib/providers/vibe.ts — the connector slot. Dispatch FAILS HONESTLY
//      with a not-configured / pending-vendor-contract reason until real Vibe
//      API access exists. Status stays 'draft' until a human marks launched.
//
// No simulated launches, no fake external ids — same honesty rule as the rest
// of the ads domain (lib/ads/launch-assembler.ts: "no fake live state").

import { createServiceClient } from "@/lib/supabase/service"
import { VIBE_HOME_URL } from "@/lib/providers/vibe"

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
export const CTV_SPOT_LENGTHS_SECONDS = [15, 30] as const
export const CTV_DURATION_TOLERANCE_SECONDS = 2

interface CreativeFacts {
  videoUrl: string | null
  durationSeconds: number | null
  /** ai_video_projects.format free text — "16:9" | "9:16" | "1:1" | other/null. */
  format: string | null
  status: string | null
}

export interface CtvCreativeCheck {
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
export function validateCtvCreative(facts: CreativeFacts): CtvCreativeCheck {
  const reasons: string[] = []
  const warnings: string[] = []

  if (facts.status !== "completed") {
    reasons.push(`video is not completed (status '${facts.status ?? "unknown"}') — only a fully rendered video can run on TV`)
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

export function summarizeCtvTargeting(t: CtvTargeting): string {
  const parts: string[] = []
  const dmas = normalizeList(t.dmas)
  const cities = normalizeList(t.cities)
  const zips = normalizeList(t.zips)
  if (dmas.length) parts.push(`DMAs: ${dmas.join(", ")}`)
  if (cities.length) parts.push(`Cities: ${cities.join(", ")}`)
  if (zips.length) parts.push(`ZIPs: ${zips.join(", ")}`)
  return parts.join(" · ")
}

export function summarizeCtvBudget(dailyBudgetCents: number): string {
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
    : videoQuery.eq("listing_id", listingId!).eq("status", "completed").not("video_url", "is", null)
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
