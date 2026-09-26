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
import { z } from "zod"
import { scanForAiTells, withSpokenScriptStandards } from "@/lib/video/realism-profile"
import {
  GUIDE_FIELDS, GUIDE_SYSTEM, cleanSuggestion, needsChecklist, needsPrompt, readyToSuggest, sanitizeSuggestions, suggestPrompt,
  type GuideField, type NeedsChecklist,
} from "@/lib/video/video-guide"
import {
  PERSONA_AUDIENCE, personaForSlot, personaForTopicCategories, seasonalCategories, topicArchetypeFor, topicGoal,
  type TopicVideoPersona,
} from "@/lib/video/topic-video"

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
  /** Wave 82C — a topic picked from the ONE topic pool (content_topic_bank). Re-read under the
   *  session tenant's visibility before it is trusted; claimed for the office once the video is staged. */
  topicId?: string | null
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
      targetChannel: input.targetChannel ?? null,
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
  // A picked topic must be one this tenant can see (its own row or the platform-wide bank).
  const topic = input.topicId ? await readVisibleTopic(brokerageId, input.topicId) : null
  if (input.topicId && !topic) return { success: false, error: "That topic is no longer in your topic pool" }
  const { commissionCustomVideo } = await import("@/lib/video/video-director")
  const r = await commissionCustomVideo(b.brief, { brokerageId, agentUserId: userId, targetChannel: input.targetChannel ?? "instagram" })
  if (!r.ok) return { success: false, error: r.reason, violations: r.violations }
  // THE OFFICE CLAIM — recorded after the asset exists (same ledger the autonomous runner writes).
  if (topic && r.status === "staged" && r.videoProjectId) {
    const agentId = await agentIdForUser(brokerageId, userId)
    const { logTopicUses } = await import("@/lib/content-intel/performance-aggregator")
    await logTopicUses({ topicIds: [topic.id], brokerageId, assetType: "situational_reel", assetId: r.videoProjectId, agentId })
  }
  return {
    success: true, videoProjectId: r.videoProjectId, mlsVideoProjectId: r.mls?.videoProjectId ?? null,
    status: r.status, compositionId: r.compositionId, archetype: r.plan?.archetype, purpose: r.plan?.purpose,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WAVE 82C — THE TOPIC POOL ON THE CARD + THE AI GUIDE
//
// OWNER (2026-09-25): "on the describe video card, when you pick this kind of
// video, the ai then tells the user what they will need and assist on their
// wording in the text boxes during the process (so an ai helping and guiding
// them so they feel supported especially if they are not techy). on the card
// they can also pick from the topic pool."
//
// The pool is the ONE pool (content_topic_bank via pickTopics). What-you-need is
// DERIVED (lib/video/video-guide.ts needsChecklist); the model only phrases it and
// offers rewrites — routed + booked (generateObjectRouted, feature
// video_brief_guide, brokerageId + userId from the SESSION), every model line
// scanned for hard fair-housing flags before it reaches the person. A model
// outage leaves the derived checklist on screen (aiAvailable:false) — never blank.
// ─────────────────────────────────────────────────────────────────────────────

interface VisibleTopic { id: string; brokerage_id: string | null; topic_title: string; value_angle: string | null; categories: string[] }

async function readVisibleTopic(brokerageId: string, topicId: string): Promise<VisibleTopic | null> {
  if (!isValidUUID(topicId)) return null
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { data, error } = await createServiceClient().from("content_topic_bank")
    .select("id, brokerage_id, topic_title, value_angle, categories")
    .eq("id", topicId)
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
    .maybeSingle()
  if (error) { console.error("[custom-video] topic read refused:", error.message); return null }
  return (data as VisibleTopic | null) ?? null
}

async function agentIdForUser(brokerageId: string, userId: string): Promise<string | null> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { data, error } = await createServiceClient().from("agents")
    .select("id").eq("user_id", userId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) { console.error("[custom-video] agent lookup refused:", error.message); return null }
  return (data as { id: string } | null)?.id ?? null
}

/** Hard fair-housing flags on a line, for either journey. */
async function flagsFor(text: string): Promise<string[]> {
  const { detectFairHousingRedFlags } = await import("@/lib/video/script-compliance")
  return Array.from(new Set([...detectFairHousingRedFlags(text, "buyer"), ...detectFairHousingRedFlags(text, "seller")]))
}

export interface VideoTopicOption {
  id: string
  title: string
  angle: string | null
  categories: string[]
  isLocal: boolean
  geoMatch: boolean
  /** Prefills the card offers (the person can change every one). */
  suggestedArchetype: CustomVideoArchetype
  suggestedGoal: string
  suggestedAudience: string
}

export interface VideoTopicPoolResult { success: boolean; error?: string; season?: string; topics?: VideoTopicOption[] }

// Wave 83: the suggested audience is keyed by CONTACT PERSONA (contacts.contact_persona),
// never contact_type — topic-video.ts personaForTopicCategories is the one rule; a topic
// with no persona overlap falls back to this week's first slot's persona.
function personaForTopic(categories: string[], now: Date, brokerageId: string): TopicVideoPersona {
  return personaForTopicCategories(categories, personaForSlot(now, brokerageId, 0, 1))
}

/** THE TOPIC POOL ON THE CARD — the tenant's freshest, in-season, territory-boosted topics. Read only (nothing is claimed until a video is staged). */
export async function listVideoTopicPoolAction(): Promise<VideoTopicPoolResult> {
  const auth = await resolveCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const { brokerageId, userId } = auth.caller
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { data: b, error: bErr } = await createServiceClient().from("brokerages").select("city, state, zip").eq("id", brokerageId).maybeSingle()
  if (bErr) return { success: false, error: "Could not read your brokerage's location for the topic pool" }
  const loc = (b ?? {}) as { city?: string | null; state?: string | null; zip?: string | null }
  const now = new Date()
  const season = seasonalCategories(now.getUTCMonth())
  const agentId = await agentIdForUser(brokerageId, userId)
  const { pickTopics } = await import("@/lib/content-intel/topic-bank")
  const picked = await pickTopics({
    brokerageId, limit: 8, markUsed: false, assetType: "situational_reel", agentId,
    recipientLocation: { city: loc.city ?? null, state: loc.state ?? null, zip_code: loc.zip ?? null },
    boostCategories: season.categories,
  })
  const noAssets = { avatarClip: false, brollClips: 0, propertyPhotos: 0, screenshots: 0, statCards: 0, clientFootage: 0, chartData: false }
  return {
    success: true,
    season: season.why,
    topics: picked.map((t) => ({
      id: t.id, title: t.topic_title, angle: t.value_angle, categories: t.categories,
      isLocal: t.is_brokerage_local, geoMatch: t.geo_match,
      suggestedArchetype: topicArchetypeFor(t, "avatar", { ...noAssets, avatarClip: true }).archetype,
      suggestedGoal: topicGoal(t),
      suggestedAudience: PERSONA_AUDIENCE[personaForTopic(t.categories, now, brokerageId)],
    })),
  }
}

export interface VideoGuideResult {
  success: boolean
  error?: string
  checklist?: NeedsChecklist
  /** The model's warm phrasing of the checklist — null when the model was unreachable or its words were refused. */
  reassurance?: string | null
  tips?: string[]
  aiAvailable?: boolean
}

/** WHAT YOU WILL NEED — the derived checklist for a kind of video, phrased warmly by the routed guide. */
export async function getVideoGuideAction(input: { archetype: string; topicId?: string | null }): Promise<VideoGuideResult> {
  const auth = await resolveCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  if (!(CUSTOM_VIDEO_ARCHETYPES as readonly string[]).includes(input.archetype)) return { success: false, error: `Pick one of: ${CUSTOM_VIDEO_ARCHETYPES.join(", ")}` }
  const checklist = needsChecklist(input.archetype as CustomVideoArchetype)
  const topic = input.topicId ? await readVisibleTopic(auth.caller.brokerageId, input.topicId) : null
  try {
    const { generateObjectRouted } = await import("@/lib/ai/models")
    const { object } = await generateObjectRouted({
      feature: "video_brief_guide",
      brokerageId: auth.caller.brokerageId,
      userId: auth.caller.userId,
      system: GUIDE_SYSTEM,
      prompt: needsPrompt(checklist, topic?.topic_title ?? null),
      schema: z.object({ reassurance: z.string().max(500), tips: z.array(z.string().max(160)).max(3) }),
      maxTokens: 400,
    })
    const reassuranceFlags = await flagsFor(object.reassurance)
    const tips: string[] = []
    for (const t of object.tips) if ((await flagsFor(t)).length === 0) tips.push(t.trim())
    return { success: true, checklist, reassurance: reassuranceFlags.length ? null : object.reassurance.trim(), tips, aiAvailable: true }
  } catch (e) {
    console.warn("[custom-video] guide unavailable; derived checklist only:", (e as Error).message)
    return { success: true, checklist, reassurance: null, tips: [], aiAvailable: false }
  }
}

export interface WordingSuggestionResult {
  success: boolean
  error?: string
  suggestions?: string[]
  why?: string | null
  /** Hard fair-housing flags on what the PERSON typed — shown as a gentle heads-up; the Director's gate still blocks at commission. */
  warnings?: string[]
  droppedForFairHousing?: number
}

/** WORDING HELP for one text box — up to three rewrites the person can accept or edit. */
export async function suggestVideoWordingAction(input: {
  field: string; text: string; archetype?: string | null; goal?: string | null; audience?: string | null; topicTitle?: string | null
}): Promise<WordingSuggestionResult> {
  const auth = await resolveCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  if (!(GUIDE_FIELDS as readonly string[]).includes(input.field)) return { success: false, error: `field must be one of ${GUIDE_FIELDS.join(", ")}` }
  const field = input.field as GuideField
  const text = String(input.text ?? "")
  if (!readyToSuggest(field, text)) return { success: true, suggestions: [], why: null, warnings: [] }
  const archetype = input.archetype && (CUSTOM_VIDEO_ARCHETYPES as readonly string[]).includes(input.archetype) ? (input.archetype as CustomVideoArchetype) : null
  const warnings = await flagsFor(text)
  try {
    const { generateObjectRouted } = await import("@/lib/ai/models")
    const { object } = await generateObjectRouted({
      feature: "video_brief_guide",
      brokerageId: auth.caller.brokerageId,
      userId: auth.caller.userId,
      system: GUIDE_SYSTEM,
      // The SCRIPT box becomes spoken narration — its suggestions carry the same spoken
      // standards every script writer uses, and a suggestion with AI tells is not offered.
      prompt: field === "script"
        ? withSpokenScriptStandards(suggestPrompt({ field, text, archetype, goal: input.goal ?? null, audience: input.audience ?? null, topicTitle: input.topicTitle ?? null }))
        : suggestPrompt({ field, text, archetype, goal: input.goal ?? null, audience: input.audience ?? null, topicTitle: input.topicTitle ?? null }),
      schema: z.object({ suggestions: z.array(z.string().max(1400)).max(3), why: z.string().max(240) }),
      maxTokens: 700,
    })
    const cleaned = object.suggestions.map((s) => cleanSuggestion(s, field))
      .filter((s) => field !== "script" || scanForAiTells(s).length === 0)
    const flagged = new Set<string>()
    for (const s of cleaned) if ((await flagsFor(s)).length > 0) flagged.add(s)
    const { kept, droppedForFairHousing } = sanitizeSuggestions(cleaned, text, field, (s) => flagged.has(s))
    const whyFlags = await flagsFor(object.why)
    return { success: true, suggestions: kept, why: whyFlags.length ? null : object.why.trim(), warnings, droppedForFairHousing }
  } catch (e) {
    return { success: false, error: `Wording help is unavailable right now (${(e as Error).message}) — your text is kept as you wrote it`, warnings }
  }
}
