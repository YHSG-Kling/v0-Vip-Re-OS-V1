"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { generateAIResponse } from "@/lib/ai"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { getPlatformConfig, getAllPlatformConfigs, validateSnippetForPlatform } from "./video-repurposing.utils"

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
const PLATFORM_CONFIGS: Record<PlatformTarget, {
  maxDuration: number
  aspectRatio: AspectRatio
  maxCaptionLength: number
  hashtagLimit: number
  displayName: string
}> = {
  instagram_reels: { maxDuration: 90, aspectRatio: "9:16", maxCaptionLength: 2200, hashtagLimit: 30, displayName: "Instagram Reels" },
  instagram_story: { maxDuration: 60, aspectRatio: "9:16", maxCaptionLength: 0, hashtagLimit: 10, displayName: "Instagram Stories" },
  instagram_post: { maxDuration: 60, aspectRatio: "1:1", maxCaptionLength: 2200, hashtagLimit: 30, displayName: "Instagram Post" },
  tiktok: { maxDuration: 180, aspectRatio: "9:16", maxCaptionLength: 2200, hashtagLimit: 100, displayName: "TikTok" },
  youtube_shorts: { maxDuration: 60, aspectRatio: "9:16", maxCaptionLength: 100, hashtagLimit: 15, displayName: "YouTube Shorts" },
  facebook_reels: { maxDuration: 90, aspectRatio: "9:16", maxCaptionLength: 2200, hashtagLimit: 30, displayName: "Facebook Reels" },
  linkedin: { maxDuration: 600, aspectRatio: "16:9", maxCaptionLength: 3000, hashtagLimit: 5, displayName: "LinkedIn Video" },
  twitter: { maxDuration: 140, aspectRatio: "16:9", maxCaptionLength: 280, hashtagLimit: 10, displayName: "Twitter/X Video" },
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

export async function getSnippetById(snippetId: string) {
  if (!isValidUUID(snippetId)) return null

  const auth = await requireCaller()
  if (!auth.ok) return null

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("video_snippets")
    .select(`
      *,
      ai_video_projects(id, title, video_url, status, script_content),
      video_assets(id, title, video_url, description)
    `)
    .eq("id", snippetId)
    .eq("brokerage_id", auth.brokerageId)
    .single()

  if (error) {
    console.error("[video-repurposing] Error fetching snippet:", error)
    return null
  }

  return data
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

  // Validate duration against platform limits
  const duration = data.endSeconds - data.startSeconds
  const maxDuration = PLATFORM_CONFIGS[normalizedPlatform].maxDuration

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

export async function deleteSnippet(snippetId: string) {
  if (!isValidUUID(snippetId)) throw new Error("Invalid snippet ID")

  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)

  const supabase = createServiceClient()

  // Scope by brokerage so a hostile caller can't wipe another tenant's snippets
  const { error } = await supabase
    .from("video_snippets")
    .delete()
    .eq("id", snippetId)
    .eq("brokerage_id", auth.brokerageId)

  if (error) {
    console.error("[video-repurposing] Error deleting snippet:", error)
    throw error
  }

  revalidatePath("/dashboard/videos/snippets")
  return { success: true }
}

// ============================================
// AI-POWERED SNIPPET GENERATION
// ============================================

export async function generateSnippetSuggestions(params: {
  videoProjectId?: string
  sourceVideoAssetId?: string
  /** External URL or pasted script/transcript — used when no DB video project exists */
  sourceScript?: string
  sourceTitle?: string
  brokerageId?: string  // ignored — derived from session
  platforms: PlatformTarget[]
}) {
  // Auth gate — burns paid AI inference per platform requested.
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)

  const supabase = createServiceClient()

  // Get video details — verify source belongs to caller's brokerage
  let videoDetails: { id: string; title: string; duration_seconds: number } | null = null
  let scriptContent = ""

  if (params.videoProjectId) {
    const { data } = await supabase
      .from("ai_video_projects")
      .select("id, title, script_content, duration_seconds, video_type, brokerage_id")
      .eq("id", params.videoProjectId)
      .single()
    if (data && data.brokerage_id !== auth.brokerageId) {
      throw new Error("Forbidden: video project not in your brokerage")
    }
    videoDetails = data
    scriptContent = data?.script_content || ""
  } else if (params.sourceVideoAssetId) {
    const { data } = await supabase
      .from("video_assets")
      .select("id, title, description, duration_seconds, brokerage_id")
      .eq("id", params.sourceVideoAssetId)
      .single()
    if (data && data.brokerage_id !== auth.brokerageId) {
      throw new Error("Forbidden: video asset not in your brokerage")
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
    throw new Error("Video not found")
  }

  const suggestions: Array<{
    platform: PlatformTarget
    title: string
    startSeconds: number
    endSeconds: number
    captionText: string
    hashtags: string[]
    rationale: string
  }> = []

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

  return suggestions
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
}) {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)

  const createdSnippets: VideoSnippet[] = []

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
    } catch (err) {
      console.error(`[video-repurposing] Failed to create snippet for ${snippet.platform}:`, err)
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
  return createdSnippets
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

export async function getRepurposedContentLogs(filters?: {
  brokerageId?: string  // ignored — derived from session
  sourceType?: string
  sourceId?: string
  status?: string
}) {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  let query = supabase
    .from("repurposed_content_log")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })

  if (filters?.sourceType) {
    query = query.eq("source_type", filters.sourceType)
  }
  if (filters?.sourceId) {
    query = query.eq("source_id", filters.sourceId)
  }
  if (filters?.status) {
    query = query.eq("status", filters.status)
  }

  const { data, error } = await query

  if (error) {
    console.error("[video-repurposing] Error fetching repurposed content logs:", error)
    return []
  }

  return data || []
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

  // Create social post from snippet
  const { data: post, error } = await supabase
    .from("social_posts")
    .insert({
      brokerage_id: brokerageId,
      user_id: userId,
      platform,
      post_type: snippet.platform_target,
      content: snippet.caption_text || "",
      hashtags: snippet.hashtags || [],
      media_urls: snippet.video_url ? [snippet.video_url] : [],
      scheduled_for: params.scheduledFor,
      social_account_id: params.socialAccountId,
      status: "scheduled",
      approval_status: snippet.approval_status === "approved" ? "approved" : "pending",
      brand_compliance_passed: false,
    })
    .select()
    .single()

  if (error) {
    console.error("[video-repurposing] Error scheduling snippet:", error)
    throw error
  }

  // Log the repurposing (auth-gated function — derives brokerage/user itself)
  await logRepurposedContent({
    sourceType: snippet.video_project_id ? "video_project" : "video_asset",
    sourceId: snippet.video_project_id || snippet.source_video_asset_id || "",
    outputType: "social_post",
    outputRefTable: "social_posts",
    outputRefId: post.id,
    platformTarget: snippet.platform_target as PlatformTarget,
  })

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

export async function generateCaptionVariations(params: {
  originalCaption: string
  platform: PlatformTarget
  tone?: "professional" | "casual" | "energetic" | "emotional"
  variationCount?: number
}) {
  const config = PLATFORM_CONFIGS[params.platform]
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
    // Get agent context for AI routing
    const agentContext = await getAgentContext()

    const response = await generateAIResponse({
      prompt,
      metadata: {
        userId: agentContext.userId,
        brokerageId: agentContext.brokerageId,
        agentId: agentContext.agentId,
        feature: "video_script_generation",
      },
    })

    const cleanText = response.text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim()
    const variations = JSON.parse(cleanText)

    return variations.map((v: any) => ({
      caption: v.caption.substring(0, config.maxCaptionLength),
      hashtags: (v.hashtags || []).slice(0, config.hashtagLimit),
      tone: v.tone,
    }))
  } catch (err) {
    console.error("[video-repurposing] Caption generation failed:", err)
    return [{
      caption: params.originalCaption,
      hashtags: [],
      tone: params.tone || "professional",
    }]
  }
}
