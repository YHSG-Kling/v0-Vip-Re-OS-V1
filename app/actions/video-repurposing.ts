"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { generateAIResponse } from "@/lib/ai"
import { getAgentContext } from "@/lib/identity/get-agent-context"
// The repurposed_content_log CHECK vocabularies live in the non-"use server"
// sibling: a top-level "use server" module may only export async functions.
import { REPURPOSE_LOG_STATUSES, REPURPOSE_LOG_APPROVAL_STATUSES } from "./video-repurposing.utils"

// ─── Auth helper ──────────────────────────────────────────────────────────────
//
// Every function in this file previously trusted caller-supplied
// brokerageId / createdBy / userId without authentication. Any signed-in
// (or, on most reads, unauthenticated) caller could:
//   - List/read any brokerage's video snippets and repurposing logs
//   - Delete any snippet in the database (no scope filter at all)
//   - Insert snippets / logs / scheduled social posts under arbitrary
//     brokerages with spoofed createdBy
//   - Burn paid AI inference via generateSnippetSuggestions /
//     generateCaptionVariations
// This helper resolves identity from the session; functions ignore the
// caller-supplied IDs and use session-derived values.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

// ============================================
// TYPES — Layer 8.4 Snippet & Repurposing Generator
// ============================================

// NOTE: Must match the live DB CHECK constraints on
// video_snippets.approval_status and repurposed_content_log.approval_status:
//   CHECK (approval_status IN ('draft','pending_review','approved','rejected'))
// The previous "pending" literal was schema drift and made every
// createVideoSnippet / logRepurposedContent insert fail at runtime.
export type SnippetApprovalStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"

export type PlatformTarget = 
  | "instagram_reels"
  | "instagram_story"
  | "instagram_post"
  | "tiktok"
  | "youtube_shorts"
  | "facebook_reels"
  | "linkedin"
  | "twitter"

export type AspectRatio = 
  | "9:16"  // Vertical (Reels, TikTok, Stories)
  | "1:1"   // Square (Instagram feed)
  | "16:9"  // Horizontal (YouTube, LinkedIn)
  | "4:5"   // Portrait (Facebook, Instagram feed)

export interface VideoSnippet {
  id: string
  brokerage_id: string
  source_video_asset_id: string | null
  video_project_id: string | null
  snippet_title: string
  start_seconds: number
  end_seconds: number
  aspect_ratio: AspectRatio
  platform_target: PlatformTarget
  caption_text: string | null
  hashtags: string[] | null
  thumbnail_url: string | null
  video_url: string | null
  approval_status: SnippetApprovalStatus
  created_by: string | null
  created_at: string
}

export interface RepurposedContentLog {
  id: string
  brokerage_id: string
  source_type: string
  source_id: string
  output_type: string
  output_ref_table: string
  output_ref_id: string
  platform_target: PlatformTarget | null
  status: string
  approval_status: SnippetApprovalStatus
  notes: string | null
  created_by: string | null
  created_at: string
}

// Platform-specific configurations
//
// THE ONE PLATFORM VOCABULARY FOR REPURPOSING. A second `PlatformTarget` union
// and a second `PLATFORM_CONFIGS` map lived in ./video-repurposing.utils.ts and
// disagreed with this one on both the NAMES (`instagram_reel` vs
// `instagram_reels`, `youtube_short` vs `youtube_shorts`, `linkedin_video` vs
// `linkedin`) and the LIMITS (tiktok 600s/10 hashtags there, 180s/100 here).
// Only this map reaches the database — every writer of
// `video_snippets.platform_target` normalises against it — so this is the
// survivor and the other is gone (tombstone at video-repurposing.utils.ts).
//
// `minDuration` is MERGED FORWARD from that copy: it was the one field the
// duplicate carried that this map lacked AND that had a real enforcement site
// (its validateSnippetForPlatform rejected a too-SHORT snippet, while this
// file's create path only ever checked the maximum). Values follow the
// duplicate where the platform corresponds; instagram_story and instagram_post
// exist only here and take Instagram's 3s floor, the same floor the duplicate
// gave instagram_reel.
const PLATFORM_CONFIGS: Record<PlatformTarget, {
  minDuration: number
  maxDuration: number
  aspectRatio: AspectRatio
  maxCaptionLength: number
  hashtagLimit: number
  displayName: string
}> = {
  instagram_reels: { minDuration: 3, maxDuration: 90, aspectRatio: "9:16", maxCaptionLength: 2200, hashtagLimit: 30, displayName: "Instagram Reels" },
  instagram_story: { minDuration: 3, maxDuration: 60, aspectRatio: "9:16", maxCaptionLength: 0, hashtagLimit: 10, displayName: "Instagram Stories" },
  instagram_post: { minDuration: 3, maxDuration: 60, aspectRatio: "1:1", maxCaptionLength: 2200, hashtagLimit: 30, displayName: "Instagram Post" },
  tiktok: { minDuration: 3, maxDuration: 180, aspectRatio: "9:16", maxCaptionLength: 2200, hashtagLimit: 100, displayName: "TikTok" },
  youtube_shorts: { minDuration: 15, maxDuration: 60, aspectRatio: "9:16", maxCaptionLength: 100, hashtagLimit: 15, displayName: "YouTube Shorts" },
  facebook_reels: { minDuration: 3, maxDuration: 90, aspectRatio: "9:16", maxCaptionLength: 2200, hashtagLimit: 30, displayName: "Facebook Reels" },
  linkedin: { minDuration: 3, maxDuration: 600, aspectRatio: "16:9", maxCaptionLength: 3000, hashtagLimit: 5, displayName: "LinkedIn Video" },
  twitter: { minDuration: 1, maxDuration: 140, aspectRatio: "16:9", maxCaptionLength: 280, hashtagLimit: 10, displayName: "Twitter/X Video" },
}

// ============================================
// VIDEO SNIPPETS — CRUD Operations
// Table: public.video_snippets
// ============================================

export async function getVideoSnippets(filters?: {
  brokerageId?: string  // ignored — derived from session
  videoProjectId?: string
  sourceVideoAssetId?: string
  platformTarget?: PlatformTarget
  approvalStatus?: SnippetApprovalStatus
}) {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  let query = supabase
    .from("video_snippets")
    .select(`
      *,
      ai_video_projects(id, title, video_url, status),
      video_assets(id, title, video_url)
    `)
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })

  if (filters?.videoProjectId) {
    query = query.eq("video_project_id", filters.videoProjectId)
  }
  if (filters?.sourceVideoAssetId) {
    query = query.eq("source_video_asset_id", filters.sourceVideoAssetId)
  }
  if (filters?.platformTarget) {
    query = query.eq("platform_target", filters.platformTarget)
  }
  if (filters?.approvalStatus) {
    query = query.eq("approval_status", filters.approvalStatus)
  }

  const { data, error } = await query

  if (error) {
    console.error("[video-repurposing] Error fetching snippets:", error)
    return []
  }

  return data || []
}

/**
 * WIRED: the snippet detail sheet on /dashboard/videos/snippets — "Details"
 * opens the full caption, hashtags and the source project this clip was cut
 * from. Also the ownership gate scheduleSnippetToSocial leans on.
 *
 * Reads through the SERVICE client (RLS bypassed) and is therefore gated by the
 * explicit `.eq("brokerage_id", auth.brokerageId)` below, not by policy.
 */
export async function getSnippetById(snippetId: string) {
  if (!isValidUUID(snippetId)) return null

  const auth = await requireCaller()
  if (!auth.ok) return null

  const supabase = createServiceClient()

  // .maybeSingle(), not .single(): a snippet belonging to another brokerage is
  // simply "not here", and .single() turned that ordinary miss into a logged
  // PGRST116 error every time.
  const { data, error } = await supabase
    .from("video_snippets")
    .select(`
      *,
      ai_video_projects(id, title, video_url, status, script_content),
      video_assets(id, title, video_url, description)
    `)
    .eq("id", snippetId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()

  if (error) {
    console.error("[video-repurposing] Error fetching snippet:", error)
    return null
  }

  return data
}

/** The browser-safe projection of getSnippetById for the detail sheet. */
export interface SnippetDetail {
  id: string
  snippetTitle: string
  platformTarget: string
  aspectRatio: string | null
  startSeconds: number
  endSeconds: number
  captionText: string | null
  hashtags: string[]
  approvalStatus: string
  videoUrl: string | null
  thumbnailUrl: string | null
  createdAt: string
  sourceTitle: string | null
  sourceStatus: string | null
  sourceVideoUrl: string | null
}

export async function getSnippetDetail(
  snippetId: string
): Promise<{ success: boolean; snippet?: SnippetDetail; error?: string }> {
  if (!isValidUUID(snippetId)) return { success: false, error: "Invalid snippet ID" }

  const row = await getSnippetById(snippetId)
  if (!row) return { success: false, error: "Snippet not found" }

  const r = row as Record<string, any>
  const project = r.ai_video_projects ?? null
  const asset = r.video_assets ?? null

  return {
    success: true,
    snippet: {
      id: r.id,
      snippetTitle: r.snippet_title,
      platformTarget: r.platform_target,
      aspectRatio: r.aspect_ratio ?? null,
      startSeconds: r.start_seconds,
      endSeconds: r.end_seconds,
      captionText: r.caption_text ?? null,
      hashtags: Array.isArray(r.hashtags) ? r.hashtags : [],
      approvalStatus: r.approval_status,
      videoUrl: r.video_url ?? null,
      thumbnailUrl: r.thumbnail_url ?? null,
      createdAt: r.created_at,
      sourceTitle: project?.title ?? asset?.title ?? null,
      // ai_video_projects.status has no CHECK constraint and two live
      // vocabularies; the sheet shows the raw token rather than pretending to
      // normalise it.
      sourceStatus: project?.status ?? null,
      sourceVideoUrl: project?.video_url ?? asset?.video_url ?? null,
    },
  }
}

export async function createVideoSnippet(data: {
  brokerageId?: string  // ignored — derived from session
  videoProjectId?: string
  sourceVideoAssetId?: string
  snippetTitle: string
  startSeconds: number
  endSeconds: number
  aspectRatio?: AspectRatio
  platformTarget: PlatformTarget
  captionText?: string
  hashtags?: string[]
  thumbnailUrl?: string
  createdBy?: string  // ignored — derived from session
}) {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)
  const brokerageId = auth.brokerageId
  const createdBy = auth.userId

  const supabase = createServiceClient()

  // Verify the source video/project belongs to caller's brokerage
  if (data.videoProjectId && isValidUUID(data.videoProjectId)) {
    const { data: proj } = await supabase
      .from("ai_video_projects").select("brokerage_id").eq("id", data.videoProjectId).maybeSingle()
    if (!proj || proj.brokerage_id !== brokerageId) {
      throw new Error("Forbidden: video project not in your brokerage")
    }
  }
  if (data.sourceVideoAssetId && isValidUUID(data.sourceVideoAssetId)) {
    const { data: asset } = await supabase
      .from("video_assets").select("brokerage_id").eq("id", data.sourceVideoAssetId).maybeSingle()
    if (!asset || asset.brokerage_id !== brokerageId) {
      throw new Error("Forbidden: source video asset not in your brokerage")
    }
  }

  // Normalize and validate platform_target
  const ALLOWED_PLATFORMS = Object.keys(PLATFORM_CONFIGS) as PlatformTarget[]
  const normalizedPlatform = (data.platformTarget as string)
    .toLowerCase()
    .replace(/\s+/g, "_") as PlatformTarget

  if (!ALLOWED_PLATFORMS.includes(normalizedPlatform)) {
    throw new Error(`Invalid platform "${data.platformTarget}". Must be one of: ${ALLOWED_PLATFORMS.join(", ")}`)
  }

  // Validate start/end seconds (DB enforces end_seconds > start_seconds)
  if (data.endSeconds <= data.startSeconds) {
    throw new Error(`End time (${data.endSeconds}s) must be greater than start time (${data.startSeconds}s).`)
  }

  // Auto-determine aspect ratio if not provided
  const aspectRatio = data.aspectRatio || PLATFORM_CONFIGS[normalizedPlatform].aspectRatio

  // Validate duration against platform limits — BOTH ends of the range.
  // The floor arrived with the merge from ./video-repurposing.utils.ts: a
  // one-second "YouTube Short" or a two-second Reel is rejected by the platform
  // on upload, and until now it was accepted here, stored, and only failed at
  // distribution time where the agent could no longer see why.
  const duration = data.endSeconds - data.startSeconds
  const { minDuration, maxDuration } = PLATFORM_CONFIGS[normalizedPlatform]

  if (duration < minDuration) {
    throw new Error(`Snippet duration (${duration}s) is below the ${normalizedPlatform} minimum of ${minDuration}s`)
  }
  if (duration > maxDuration) {
    throw new Error(`Snippet duration (${duration}s) exceeds ${normalizedPlatform} limit of ${maxDuration}s`)
  }

  const { data: snippet, error } = await supabase
    .from("video_snippets")
    .insert({
      brokerage_id: brokerageId,
      video_project_id: data.videoProjectId ?? null,
      source_video_asset_id: data.sourceVideoAssetId ?? null,
      snippet_title: data.snippetTitle,
      start_seconds: data.startSeconds,
      end_seconds: data.endSeconds,
      aspect_ratio: aspectRatio,
      platform_target: normalizedPlatform,
      caption_text: data.captionText ?? null,
      hashtags: data.hashtags ?? null,
      thumbnail_url: data.thumbnailUrl ?? null,
      approval_status: "pending_review",
      created_by: createdBy,
    })
    .select()
    .single()

  if (error) {
    console.error("Snippet creation error:", error)
    const message =
      error.code === "23514"
        ? `Database constraint violation: the value provided for one or more fields is not allowed. Check platform, start/end times, and aspect ratio.`
        : error.message || "Failed to create snippet."
    throw new Error(message)
  }

  // Write lifecycle event
  await supabase.from("lifecycle_events").insert({
    entity_type: "video_snippet",
    entity_id: snippet.id,
    brokerage_id: brokerageId,
    event_type: KernelEvent.SNIPPET_CREATED,
    actor_user_id: createdBy,
    metadata: {
      platform_target: normalizedPlatform,
      duration: duration,
      source_project_id: data.videoProjectId,
    },
  })

  // Fire kernel event
  await processKernelEvent({
    event: KernelEvent.SNIPPET_CREATED,
    brokerageId: brokerageId,
    entityType: "video_snippet",
    entityId: snippet.id,
  }).catch(err => console.error("[video-repurposing] Kernel event failed:", err))

  revalidatePath("/dashboard/videos/snippets")
  revalidatePath("/social-planner")
  return snippet
}

export async function updateSnippetApprovalStatus(
  snippetId: string,
  _brokerageId: string,  // ignored — derived from session
  approvalStatus: SnippetApprovalStatus,
  _actorUserId?: string  // ignored — derived from session
) {
  if (!isValidUUID(snippetId)) throw new Error("Invalid snippet ID")

  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)
  const brokerageId = auth.brokerageId
  const actorUserId = auth.userId

  const supabase = createServiceClient()

  const { data: snippet, error } = await supabase
    .from("video_snippets")
    .update({ approval_status: approvalStatus })
    .eq("id", snippetId)
    .eq("brokerage_id", brokerageId)
    .select()
    .single()

  if (error) {
    console.error("[video-repurposing] Error updating approval status:", error)
    throw error
  }

  // Write lifecycle event
  const eventType = approvalStatus === "approved"
    ? KernelEvent.SNIPPET_APPROVED
    : approvalStatus === "rejected"
      ? KernelEvent.SNIPPET_REJECTED
      : KernelEvent.SNIPPET_CREATED

  await supabase.from("lifecycle_events").insert({
    entity_type: "video_snippet",
    entity_id: snippetId,
    brokerage_id: brokerageId,
    event_type: eventType,
    actor_user_id: actorUserId,
    metadata: { approval_status: approvalStatus },
  })

  revalidatePath("/dashboard/videos/snippets")
  return snippet
}

/**
 * WIRED: the Delete control on each row of the snippet library
 * (/dashboard/videos/snippets).
 */
export async function deleteSnippet(
  snippetId: string
): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(snippetId)) return { success: false, error: "Invalid snippet ID" }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  // Scope by brokerage so a hostile caller can't wipe another tenant's snippets.
  // `count: "exact"` is what makes the refusal legible: a DELETE that matches
  // nothing SUCCEEDS in postgrest, so without the count a cross-tenant id (or an
  // already-deleted one) would have been reported to the user as a deletion.
  const { error, count } = await supabase
    .from("video_snippets")
    .delete({ count: "exact" })
    .eq("id", snippetId)
    .eq("brokerage_id", auth.brokerageId)

  if (error) {
    console.error("[video-repurposing] Error deleting snippet:", error)
    return { success: false, error: error.message }
  }

  if (!count) {
    return { success: false, error: "Snippet not found" }
  }

  revalidatePath("/dashboard/videos/snippets")
  revalidatePath("/dashboard/campaigns/repurpose")
  return { success: true }
}

// ============================================
// AI-POWERED SNIPPET GENERATION
// ============================================

export interface SnippetSuggestion {
  platform: PlatformTarget
  title: string
  startSeconds: number
  endSeconds: number
  captionText: string
  hashtags: string[]
  rationale: string
}

export interface SnippetSuggestionsResult {
  success: boolean
  suggestions: SnippetSuggestion[]
  error?: string
}

export async function generateSnippetSuggestions(params: {
  videoProjectId?: string
  sourceVideoAssetId?: string
  /** External URL or pasted script/transcript — used when no DB video project exists */
  sourceScript?: string
  sourceTitle?: string
  brokerageId?: string  // ignored — derived from session
  platforms: PlatformTarget[]
}): Promise<SnippetSuggestionsResult> {
  // Auth gate — burns paid AI inference per platform requested.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, suggestions: [], error: auth.error }

  const supabase = createServiceClient()

  // Get video details — verify source belongs to caller's brokerage
  let videoDetails: { id: string; title: string; duration_seconds: number } | null = null
  let scriptContent = ""

  if (params.videoProjectId) {
    // NOTE: .single() RESOLVES with error (PGRST116) on zero rows rather than
    // throwing, so the error has to be read — otherwise a missing project fell
    // through as `data === null`, the `data && ...` tenant check below was
    // skipped entirely, and the caller got "Video not found" for what may have
    // been a refused read.
    const { data, error } = await supabase
      .from("ai_video_projects")
      .select("id, title, script_content, duration_seconds, video_type, brokerage_id")
      .eq("id", params.videoProjectId)
      .maybeSingle()
    if (error) {
      console.error("[video-repurposing] Source project read error:", error)
      return { success: false, suggestions: [], error: error.message }
    }
    // brokerage_id is NULLABLE on ai_video_projects, so an untenanted row is
    // visible to every brokerage under RLS and this read uses the SERVICE
    // client, which bypasses RLS outright. Equality is the gate; NULL fails it.
    if (!data || data.brokerage_id !== auth.brokerageId) {
      return { success: false, suggestions: [], error: "Video project not found" }
    }
    videoDetails = data
    scriptContent = data?.script_content || ""
  } else if (params.sourceVideoAssetId) {
    const { data, error } = await supabase
      .from("video_assets")
      .select("id, title, description, duration_seconds, brokerage_id")
      .eq("id", params.sourceVideoAssetId)
      .maybeSingle()
    if (error) {
      console.error("[video-repurposing] Source asset read error:", error)
      return { success: false, suggestions: [], error: error.message }
    }
    if (!data || data.brokerage_id !== auth.brokerageId) {
      return { success: false, suggestions: [], error: "Video asset not found" }
    }
    videoDetails = data
    scriptContent = data?.description || ""
  } else if (params.sourceScript) {
    // External URL or pasted transcript — synthesize a virtual source
    videoDetails = {
      id: "external",
      title: params.sourceTitle ?? "External Content",
      duration_seconds: 120,
    }
    scriptContent = params.sourceScript
  }

  if (!videoDetails) {
    return { success: false, suggestions: [], error: "Pick a source, or paste a transcript, first." }
  }
  if (!params.platforms?.length) {
    return { success: false, suggestions: [], error: "Select at least one platform." }
  }

  const suggestions: SnippetSuggestion[] = []

  // Generate AI suggestions for each platform
  for (const platform of params.platforms) {
    const config = PLATFORM_CONFIGS[platform]
    
    const prompt = `You are a social media expert for real estate content. Analyze this video script and suggest the best clip segment for ${config.displayName}.

VIDEO SCRIPT:
${scriptContent || "No script available - suggest general engagement hooks"}

VIDEO DURATION: ${videoDetails.duration_seconds || 90} seconds
PLATFORM: ${config.displayName}
MAX CLIP DURATION: ${config.maxDuration} seconds
MAX CAPTION LENGTH: ${config.maxCaptionLength} characters
HASHTAG LIMIT: ${config.hashtagLimit}

Respond ONLY with valid JSON in this exact format:
{
  "title": "short catchy title for the clip",
  "startSeconds": 0,
  "endSeconds": 30,
  "captionText": "engaging caption optimized for this platform",
  "hashtags": ["RealEstate", "HomeForSale", "etc"],
  "rationale": "brief explanation of why this segment works"
}

Focus on:
- Hook viewers in the first 3 seconds
- Highlight emotional moments or key property features
- Match the platform's audience expectations
- Use trending hashtags for real estate`

    try {
      const response = await generateAIResponse({
        prompt,
        metadata: {
          userId: auth.userId,
          brokerageId: auth.brokerageId,
          feature: "video_script_generation",
        },
      })

      // Parse AI response
      const cleanText = response.text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim()
      const suggestion = JSON.parse(cleanText)
      
      // Validate and constrain suggestions
      const endSeconds = Math.min(
        suggestion.endSeconds,
        suggestion.startSeconds + config.maxDuration,
        videoDetails.duration_seconds || 90
      )

      suggestions.push({
        platform,
        title: suggestion.title,
        startSeconds: Math.max(0, suggestion.startSeconds),
        endSeconds,
        captionText: suggestion.captionText.substring(0, config.maxCaptionLength),
        hashtags: (suggestion.hashtags || []).slice(0, config.hashtagLimit),
        rationale: suggestion.rationale,
      })
    } catch (err) {
      console.error(`[video-repurposing] AI suggestion failed for ${platform}:`, err)
      // Provide default suggestion
      suggestions.push({
        platform,
        title: `${videoDetails.title || "Video"} - ${config.displayName}`,
        startSeconds: 0,
        endSeconds: Math.min(config.maxDuration, videoDetails.duration_seconds || 30),
        captionText: "Check out this amazing property! 🏠✨",
        hashtags: ["RealEstate", "HomeForSale", "Property", "HomeTour"].slice(0, config.hashtagLimit),
        rationale: "Default clip from the start of the video",
      })
    }
  }

  return { success: true, suggestions }
}

export interface BatchCreateSnippetsResult {
  success: boolean
  created: VideoSnippet[]
  snippetIds: string[]
  failed: Array<{ platform: PlatformTarget; error: string }>
  error?: string
}

export async function batchCreateSnippets(params: {
  brokerageId?: string  // ignored — derived from session
  videoProjectId?: string
  sourceVideoAssetId?: string
  snippets: Array<{
    platform: PlatformTarget
    title: string
    startSeconds: number
    endSeconds: number
    captionText: string
    hashtags: string[]
  }>
  createdBy?: string  // ignored — derived from session
}): Promise<BatchCreateSnippetsResult> {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)

  const createdSnippets: VideoSnippet[] = []
  // Per-snippet failures used to be console.error'd and dropped, so the wizard
  // could report "created N snippets" for a batch in which every single insert
  // was refused. The surface reports the server's real verdict now.
  const failed: Array<{ platform: PlatformTarget; error: string }> = []

  for (const snippet of params.snippets) {
    try {
      // createVideoSnippet runs its own auth gate + source ownership check
      const created = await createVideoSnippet({
        videoProjectId: params.videoProjectId,
        sourceVideoAssetId: params.sourceVideoAssetId,
        snippetTitle: snippet.title,
        startSeconds: snippet.startSeconds,
        endSeconds: snippet.endSeconds,
        platformTarget: snippet.platform,
        captionText: snippet.captionText,
        hashtags: snippet.hashtags,
      })
      createdSnippets.push(created)

      // RECORD IT WHERE THE NEXT READER LOOKS. The Omni-Presence Repurposer's
      // History tab reads repurposed_content_log; snippets minted by the Snippet
      // Wizard never landed there, so a whole batch could be created and the
      // history the same dashboard shows would stay empty. One row per snippet,
      // keyed to the source it was cut from. Non-fatal: a log failure must not
      // discard a snippet that already exists.
      const sourceId = params.videoProjectId || params.sourceVideoAssetId
      if (sourceId) {
        await logRepurposedContent({
          sourceType: params.videoProjectId ? "video_project" : "video_asset",
          sourceId,
          outputType: "snippet",
          outputRefTable: "video_snippets",
          outputRefId: created.id,
          platformTarget: snippet.platform,
          notes: `Snippet Wizard — ${snippet.title}`,
        }).catch(err =>
          console.error("[video-repurposing] Repurpose log failed for snippet:", created.id, err)
        )
      }
    } catch (err) {
      console.error(`[video-repurposing] Failed to create snippet for ${snippet.platform}:`, err)
      failed.push({
        platform: snippet.platform,
        error: err instanceof Error ? err.message : "Snippet creation failed",
      })
    }
  }

  // Fire batch completion event
  if (createdSnippets.length > 0) {
    await processKernelEvent({
      event: KernelEvent.REPURPOSE_BATCH_COMPLETED,
      brokerageId: auth.brokerageId,
      entityType: "video_snippet_batch",
      entityId: params.videoProjectId || params.sourceVideoAssetId || "batch",
    }).catch(err => console.error("[video-repurposing] Batch kernel event failed:", err))
  }

  revalidatePath("/dashboard/videos/snippets")
  revalidatePath("/dashboard/campaigns/repurpose")
  return {
    success: createdSnippets.length > 0,
    created: createdSnippets,
    snippetIds: createdSnippets.map(s => s.id),
    failed,
    error:
      createdSnippets.length === 0
        ? failed[0]?.error ?? "No snippets were created."
        : undefined,
  }
}

// ============================================
// REPURPOSED CONTENT LOG
// Table: public.repurposed_content_log
// ============================================

export async function logRepurposedContent(data: {
  brokerageId?: string  // ignored — derived from session
  sourceType: "video_project" | "video_asset" | "script" | "social_post"
  sourceId: string
  outputType: "snippet" | "social_post" | "story" | "reel"
  outputRefTable: string
  outputRefId: string
  platformTarget?: PlatformTarget
  notes?: string
  createdBy?: string  // ignored — derived from session
}) {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)
  const brokerageId = auth.brokerageId
  const createdBy = auth.userId

  // repurposed_content_log.source_id is `uuid NOT NULL`. Callers were passing
  // `a || b || ""` for it, and postgres rejects "" as 22P02 invalid input syntax
  // for type uuid — so the log row for a snippet with neither a project nor an
  // asset behind it never landed, and the throw surfaced on the SCHEDULING call
  // that had already succeeded. Refuse it here, by name.
  if (!isValidUUID(data.sourceId)) {
    throw new Error("logRepurposedContent: sourceId must be a uuid — repurposed_content_log.source_id is NOT NULL")
  }
  if (!isValidUUID(data.outputRefId)) {
    throw new Error("logRepurposedContent: outputRefId must be a uuid")
  }

  const supabase = createServiceClient()

  const { data: log, error } = await supabase
    .from("repurposed_content_log")
    .insert({
      brokerage_id: brokerageId,
      source_type: data.sourceType,
      source_id: data.sourceId,
      output_type: data.outputType,
      output_ref_table: data.outputRefTable,
      output_ref_id: data.outputRefId,
      platform_target: data.platformTarget ?? null,
      status: "generated",
      approval_status: "pending_review",
      notes: data.notes ?? null,
      created_by: createdBy,
    })
    .select()
    .single()

  if (error) {
    console.error("[video-repurposing] Error logging repurposed content:", error)
    throw error
  }

  // Fire kernel event
  await processKernelEvent({
    event: KernelEvent.CONTENT_REPURPOSED,
    brokerageId: brokerageId,
    entityType: "repurposed_content",
    entityId: log.id,
  }).catch(err => console.error("[video-repurposing] Kernel event failed:", err))

  return log
}

/**
 * WIRED: the History tab of the Omni-Presence Repurposer
 * (/dashboard/campaigns/repurpose) — the "Refine" controls call this to filter
 * the log by source type, output status and approval state.
 *
 * NOT a duplicate of lib/repurpose/actions.ts:getRepurposeHistory, which is the
 * page's unfiltered first paint: that one takes brokerageId as an ARGUMENT and
 * filters on it (authenticating nothing) and offers no filters at all. This one
 * derives the tenant from the session and is the only filtered reader. The
 * first-paint call is left where it is; this narrows what is already on screen.
 *
 * Status vocabulary is settled by the DB here, not by convention:
 * repurposed_content_log_status_check = generated | scheduled | published |
 * failed; repurposed_content_log_approval_status_check = draft | pending_review
 * | approved | rejected. Anything else is refused before it reaches postgrest.
 */
export async function getRepurposedContentLogs(filters?: {
  brokerageId?: string  // ignored — derived from session
  sourceType?: string
  sourceId?: string
  status?: string
  approvalStatus?: string
  platformTarget?: string
  limit?: number
}): Promise<RepurposedContentLog[]> {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  let query = supabase
    .from("repurposed_content_log")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(filters?.limit ?? 100, 1), 500))

  if (filters?.sourceType) {
    query = query.eq("source_type", filters.sourceType)
  }
  if (filters?.sourceId && isValidUUID(filters.sourceId)) {
    query = query.eq("source_id", filters.sourceId)
  }
  if (filters?.status && (REPURPOSE_LOG_STATUSES as readonly string[]).includes(filters.status)) {
    query = query.eq("status", filters.status)
  }
  if (
    filters?.approvalStatus &&
    (REPURPOSE_LOG_APPROVAL_STATUSES as readonly string[]).includes(filters.approvalStatus)
  ) {
    query = query.eq("approval_status", filters.approvalStatus)
  }
  if (filters?.platformTarget) {
    query = query.eq("platform_target", filters.platformTarget)
  }

  const { data, error } = await query

  if (error) {
    console.error("[video-repurposing] Error fetching repurposed content logs:", error)
    return []
  }

  return (data || []) as RepurposedContentLog[]
}

/**
 * The History tab's filtered read, with the server's verdict attached so the
 * surface can say "the filter was refused" instead of silently rendering an
 * empty table over a failed query.
 */
export async function getFilteredRepurposeHistory(filters: {
  sourceType?: string
  status?: string
  approvalStatus?: string
}): Promise<{ success: boolean; history: RepurposedContentLog[]; error?: string }> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, history: [], error: auth.error }

  if (filters.status && !(REPURPOSE_LOG_STATUSES as readonly string[]).includes(filters.status)) {
    return { success: false, history: [], error: `Unknown status "${filters.status}".` }
  }
  if (
    filters.approvalStatus &&
    !(REPURPOSE_LOG_APPROVAL_STATUSES as readonly string[]).includes(filters.approvalStatus)
  ) {
    return { success: false, history: [], error: `Unknown approval status "${filters.approvalStatus}".` }
  }

  const history = await getRepurposedContentLogs({
    sourceType: filters.sourceType,
    status: filters.status,
    approvalStatus: filters.approvalStatus,
  })

  return { success: true, history }
}

// ============================================
// SCHEDULE SNIPPET TO SOCIAL PLANNER
// ============================================

export async function scheduleSnippetToSocial(params: {
  snippetId: string
  brokerageId?: string  // ignored — derived from session
  scheduledFor: string
  socialAccountId?: string
  userId?: string  // ignored — derived from session
}) {
  if (!isValidUUID(params.snippetId)) throw new Error("Invalid snippet ID")

  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)
  const brokerageId = auth.brokerageId
  const userId = auth.userId

  const supabase = createServiceClient()

  // getSnippetById runs its own auth + brokerage gate so we can trust this
  const snippet = await getSnippetById(params.snippetId)
  if (!snippet) throw new Error("Snippet not found")

  // Verify social_account belongs to caller's brokerage if provided
  if (params.socialAccountId && isValidUUID(params.socialAccountId)) {
    // social_media_accounts is the canonical account store (social_accounts was
    // a writer-less legacy twin — burn-down round 3 repoint).
    const { data: acct } = await supabase
      .from("social_media_accounts").select("brokerage_id").eq("id", params.socialAccountId).maybeSingle()
    if (!acct || acct.brokerage_id !== brokerageId) {
      throw new Error("Forbidden: social account not in your brokerage")
    }
  }

  // Map platform target to social platform
  const platformMap: Record<PlatformTarget, string> = {
    instagram_reels: "instagram",
    instagram_story: "instagram",
    instagram_post: "instagram",
    tiktok: "tiktok",
    youtube_shorts: "youtube",
    facebook_reels: "facebook",
    linkedin: "linkedin",
    twitter: "twitter",
  }

  const platform = platformMap[snippet.platform_target as PlatformTarget]
  if (!platform) {
    throw new Error(`Snippet targets "${snippet.platform_target}", which is not a publishable platform.`)
  }

  // POST_TYPE IS A CHECKED COLUMN, AND THIS WAS WRITING THE WRONG VOCABULARY.
  // social_posts_post_type_check = new_listing | coming_soon |
  // open_house_announcement | open_house_reminder | price_reduction |
  // just_sold | open_house_recap | market_update | custom | carousel.
  // The snippet's platform_target ('instagram_reels', 'tiktok', …) is in NONE
  // of them, so every "Queue to omnipresence" click failed with 23514 — the
  // live table holds zero rows in that shape because the insert can never land.
  // 'custom' is the CHECK's catch-all; the platform target it was trying to
  // record survives in post_brief, which is free text.
  const { data: post, error } = await supabase
    .from("social_posts")
    .insert({
      brokerage_id: brokerageId,
      user_id: userId,
      platform,
      post_type: "custom",
      post_brief: `Video snippet — ${snippet.platform_target}`,
      content: snippet.caption_text || "",
      hashtags: snippet.hashtags || [],
      media_urls: snippet.video_url ? [snippet.video_url] : [],
      scheduled_for: params.scheduledFor,
      social_account_id: params.socialAccountId ?? null,
      status: "scheduled",
      // social_posts_approval_status_check = pending | approved | rejected.
      // An unapproved snippet stays 'pending' so the existing consent-gated
      // publisher will not send it — this action queues, it never publishes.
      approval_status: snippet.approval_status === "approved" ? "approved" : "pending",
      brand_compliance_passed: false,
    })
    .select()
    .single()

  if (error) {
    console.error("[video-repurposing] Error scheduling snippet:", error)
    throw error
  }

  // Log the repurposing (auth-gated function — derives brokerage/user itself).
  // Only when the snippet actually has a source: a standalone snippet (created
  // straight from the New Snippet sheet with no project or asset behind it) has
  // no uuid to put in the NOT NULL source_id, and the previous `|| ""` made this
  // throw AFTER the social_posts row was already written — the post existed, the
  // user saw a failure, and a retry queued a duplicate.
  const logSourceId = snippet.video_project_id || snippet.source_video_asset_id
  if (logSourceId) {
    await logRepurposedContent({
      sourceType: snippet.video_project_id ? "video_project" : "video_asset",
      sourceId: logSourceId,
      outputType: "social_post",
      outputRefTable: "social_posts",
      outputRefId: post.id,
      platformTarget: snippet.platform_target as PlatformTarget,
    }).catch(err =>
      console.error("[video-repurposing] Repurpose log failed for scheduled post:", post.id, err)
    )
  }

  // Fire kernel event
  await processKernelEvent({
    event: KernelEvent.SNIPPET_SCHEDULED,
    brokerageId: brokerageId,
    entityType: "video_snippet",
    entityId: params.snippetId,
  }).catch(err => console.error("[video-repurposing] Kernel event failed:", err))

  revalidatePath("/social-planner")
  revalidatePath("/dashboard/videos/snippets")

  return post
}

// ============================================
// GENERATE CAPTION VARIATIONS
// ============================================

export interface CaptionVariation {
  caption: string
  hashtags: string[]
  tone: string
}

export interface CaptionVariationsResult {
  success: boolean
  variations: CaptionVariation[]
  error?: string
}

/**
 * WIRED: the "New Snippet" sheet on /dashboard/videos/snippets — the agent
 * writes a caption, asks for variations, and picks one, which then becomes the
 * caption_text createVideoSnippet persists.
 *
 * Two defects fixed here:
 *  · NO AUTH GATE. This module's own header claims every function is gated,
 *    but this one was not — it was a browser-callable endpoint that burned paid
 *    AI inference for anyone who could reach it, authenticated or not.
 *    getAgentContext() below resolves identity for ROUTING, it does not refuse.
 *  · SILENT FAILURE. On any error it returned `[{ caption: originalCaption }]`,
 *    i.e. the input echoed back dressed as a result. The surface could not tell
 *    "here are your variations" from "the model refused", so it would have
 *    reported an optimistic success over a refusal. The verdict is explicit now.
 */
export async function generateCaptionVariations(params: {
  originalCaption: string
  platform: PlatformTarget
  tone?: "professional" | "casual" | "energetic" | "emotional"
  variationCount?: number
}): Promise<CaptionVariationsResult> {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, variations: [], error: auth.error }

  const config = PLATFORM_CONFIGS[params.platform]
  if (!config) {
    return { success: false, variations: [], error: `Unknown platform "${params.platform}".` }
  }
  if (!params.originalCaption?.trim()) {
    return { success: false, variations: [], error: "Write a caption first — there is nothing to vary." }
  }
  const count = params.variationCount || 3

  const prompt = `Generate ${count} different caption variations for a real estate social media post on ${config.displayName}.

ORIGINAL CAPTION:
${params.originalCaption}

TONE: ${params.tone || "professional"}
MAX LENGTH: ${config.maxCaptionLength} characters
HASHTAG LIMIT: ${config.hashtagLimit}

Respond with a JSON array of variations:
[
  {
    "caption": "the caption text",
    "hashtags": ["tag1", "tag2"],
    "tone": "the tone used"
  }
]

Make each variation unique with different:
- Hook styles (question, statement, emoji-led)
- Call-to-actions
- Emotional appeals
- Hashtag strategies`

  try {
    // Agent context is for AI ROUTING ONLY — the refusal decision was made by
    // requireCaller above. agentContext.agentId is agents-class and stays in
    // the routing metadata; it is never mixed with the users-class userId.
    const agentContext = await getAgentContext()

    const response = await generateAIResponse({
      prompt,
      metadata: {
        userId: auth.userId,
        brokerageId: auth.brokerageId,
        agentId: agentContext.agentId,
        feature: "video_script_generation",
      },
    })

    const cleanText = response.text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim()
    const parsed = JSON.parse(cleanText)
    if (!Array.isArray(parsed)) {
      return { success: false, variations: [], error: "The model did not return a list of variations." }
    }

    const variations: CaptionVariation[] = parsed
      .filter((v: any) => typeof v?.caption === "string" && v.caption.trim())
      .map((v: any) => ({
        caption: String(v.caption).substring(0, config.maxCaptionLength),
        hashtags: (Array.isArray(v.hashtags) ? v.hashtags : []).slice(0, config.hashtagLimit).map(String),
        tone: typeof v.tone === "string" ? v.tone : (params.tone || "professional"),
      }))

    if (variations.length === 0) {
      return { success: false, variations: [], error: "The model returned no usable variations. Try again." }
    }

    return { success: true, variations }
  } catch (err) {
    console.error("[video-repurposing] Caption generation failed:", err)
    return {
      success: false,
      variations: [],
      error: err instanceof Error ? err.message : "Caption generation failed.",
    }
  }
}
