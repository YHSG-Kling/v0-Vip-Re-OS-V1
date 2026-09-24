"use server"

/**
 * app/actions/custom-video.ts — THE "DESCRIBE A VIDEO" DOOR (wave 81C).
 *
 * OWNER (2026-09-24): "make sure user can create any type of video to use with
 * real estate not just the ones we listed."
 *
 * Every export here is a public HTTP endpoint (CLAUDE.md §4). The tenant and
 * the agent come from the SESSION — never from the body. The body is a
 * CustomVideoBrief (audience, goal, host, a length wish, the assets on hand,
 * optional content) which lib/video/custom-video-archetypes.ts classifies by
 * rule; a brief that maps to no archetype is refused with the reason. The
 * commission rides the ONE Director rail (commissionCustomVideo) — hook gate,
 * content contract, plan-before-send gate, pending_review — the same door an
 * AI manager uses autonomously (lib/agents/asset-manager-actions.ts
 * direct_video kind "custom").
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import {
  CUSTOM_VIDEO_ARCHETYPES, planCustomVideo,
  type CustomVideoArchetype, type CustomVideoBrief,
} from "@/lib/video/custom-video-archetypes"
import type { HostKind } from "@/lib/video/duration-model"

interface Caller { userId: string; brokerageId: string }

async function resolveCaller(): Promise<{ ok: true; caller: Caller } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: row } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = (row as { brokerage_id: string | null } | null)?.brokerage_id ?? null
  if (!brokerageId) return { ok: false, error: "No brokerage on your account" }
  return { ok: true, caller: { userId: user.id, brokerageId } }
}

export interface DescribeVideoInput {
  audience: string
  goal: string
  host: HostKind
  lengthWishSeconds?: number | null
  archetypeHint?: string | null
  /** Hosted URLs the describer has on hand — counted as the brief's assets. */
  photoUrls?: string[]
  screenshotUrls?: string[]
  clientFootageUrls?: string[]
  /** Stat cards as { label, value } pairs. */
  stats?: Array<{ label: string; value: string; delta?: string | null }>
  /** The narration / on-screen copy the describer wrote (compliance-gated downstream). */
  script?: string | null
  title?: string | null
  bullets?: string[]
  listingId?: string | null
  targetChannel?: "tiktok" | "instagram" | "youtube" | "facebook" | "email" | "portal"
}

const HOSTS: HostKind[] = ["voiceover", "avatar", "silent"]

function toBrief(input: DescribeVideoInput, avatarReady: boolean): { ok: true; brief: CustomVideoBrief } | { ok: false; error: string } {
  const audience = (input.audience ?? "").trim()
  const goal = (input.goal ?? "").trim()
  if (goal.length < 3 || goal.length > 600) return { ok: false, error: "Describe the goal in 3-600 characters" }
  if (audience.length > 200) return { ok: false, error: "Audience must be 200 characters or fewer" }
  if (!HOSTS.includes(input.host)) return { ok: false, error: `host must be one of ${HOSTS.join(", ")}` }
  const hint = input.archetypeHint && (CUSTOM_VIDEO_ARCHETYPES as readonly string[]).includes(input.archetypeHint) ? (input.archetypeHint as CustomVideoArchetype) : null
  if (input.archetypeHint && !hint) return { ok: false, error: `archetype must be one of ${CUSTOM_VIDEO_ARCHETYPES.join(", ")}` }
  const urls = (xs?: string[]) => (xs ?? []).map((u) => String(u).trim()).filter((u) => /^https?:\/\//.test(u))
  const photoUrls = urls(input.photoUrls), screenshotUrls = urls(input.screenshotUrls), clientFootageUrls = urls(input.clientFootageUrls)
  const stats = (input.stats ?? []).filter((s) => s && typeof s.label === "string" && typeof s.value === "string").slice(0, 6)
  const bullets = (input.bullets ?? []).map((b) => String(b).trim()).filter(Boolean).slice(0, 6)
  const content: Record<string, unknown> = {}
  if (photoUrls.length) content.imageUrls = photoUrls
  if (screenshotUrls.length) content.screenshotUrls = screenshotUrls
  if (clientFootageUrls.length) content.clientFootageUrls = clientFootageUrls
  if (stats.length) content.stats = stats
  if (input.script?.trim()) { content.captionScript = input.script.trim(); content.caption = input.script.trim() }
  if (input.title?.trim()) content.title = input.title.trim()
  if (bullets.length) content.bullets = bullets
  return {
    ok: true,
    brief: {
      audience, goal, host: input.host,
      lengthWishSeconds: Number.isFinite(input.lengthWishSeconds as number) ? Number(input.lengthWishSeconds) : null,
      archetypeHint: hint,
      assets: {
        avatarClip: input.host === "avatar" ? avatarReady : false,
        brollClips: 0, propertyPhotos: photoUrls.length, screenshots: screenshotUrls.length,
        statCards: stats.length, clientFootage: clientFootageUrls.length, chartData: false,
      },
      content,
      listingId: input.listingId && isValidUUID(input.listingId) ? input.listingId : null,
    },
  }
}

async function avatarReadiness(brokerageId: string, agentUserId: string): Promise<boolean> {
  try {
    const { resolveAgentPresenterMedia } = await import("@/lib/video/presenter-media")
    const p = await resolveAgentPresenterMedia({ agentUserId, brokerageId })
    return p.canRender
  } catch { return false }
}

export interface DescribeVideoPreview {
  success: boolean
  error?: string
  archetype?: string
  purpose?: string
  compositionId?: string
  targetSeconds?: number
  band?: { minSeconds: number; idealSeconds: number; maxSeconds: number }
  cuts?: string[]
  reason?: string
}

/** PLAN ONLY — what the rule makes of the description, before anything is staged. */
export async function previewDescribedVideoAction(input: DescribeVideoInput): Promise<DescribeVideoPreview> {
  const auth = await resolveCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const ready = input.host === "avatar" ? await avatarReadiness(auth.caller.brokerageId, auth.caller.userId) : false
  const b = toBrief(input, ready)
  if (!b.ok) return { success: false, error: b.error }
  const planned = planCustomVideo(b.brief)
  if (!planned.ok) return { success: false, error: planned.reason }
  const { plan } = planned
  return {
    success: true, archetype: plan.archetype, purpose: plan.purpose, compositionId: plan.compositionId,
    targetSeconds: plan.band.targetSeconds, band: { minSeconds: plan.band.minSeconds, idealSeconds: plan.band.idealSeconds, maxSeconds: plan.band.maxSeconds },
    cuts: plan.cuts, reason: plan.reason,
  }
}

export interface DescribeVideoResult {
  success: boolean
  error?: string
  violations?: string[]
  videoProjectId?: string
  mlsVideoProjectId?: string | null
  status?: string
  compositionId?: string
  archetype?: string
  purpose?: string
}

/** COMMISSION — the described video through the ONE Director rail. */
export async function createDescribedVideoAction(input: DescribeVideoInput): Promise<DescribeVideoResult> {
  const auth = await resolveCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const { userId, brokerageId } = auth.caller
  const ready = input.host === "avatar" ? await avatarReadiness(brokerageId, userId) : false
  const b = toBrief(input, ready)
  if (!b.ok) return { success: false, error: b.error }
  const { commissionCustomVideo } = await import("@/lib/video/video-director")
  const r = await commissionCustomVideo(b.brief, { brokerageId, agentUserId: userId, targetChannel: input.targetChannel ?? "instagram" })
  if (!r.ok) return { success: false, error: r.reason, violations: r.violations }
  return {
    success: true, videoProjectId: r.videoProjectId, mlsVideoProjectId: r.mls?.videoProjectId ?? null,
    status: r.status, compositionId: r.compositionId, archetype: r.plan?.archetype, purpose: r.plan?.purpose,
  }
}
