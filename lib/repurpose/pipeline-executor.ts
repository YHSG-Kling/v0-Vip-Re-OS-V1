// lib/repurpose/pipeline-executor.ts
// LAYER 9.11 — Omni-Presence Repurposer Pipeline Executor
// Orchestrates content repurposing across multiple platforms with full kernel wiring.
// REUSES existing tables: repurpose_pipelines, repurposed_content_log, video_snippets

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { generateText } from "ai"

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type SourceType = 
  | "video_project" 
  | "blog_post" 
  | "podcast_episode" 
  | "social_post"
  | "script"
  | "newsletter"

export type OutputFormat = 
  | "instagram_reels"
  | "instagram_story"
  | "instagram_carousel"
  | "tiktok"
  | "youtube_shorts"
  | "facebook_reels"
  | "linkedin_post"
  | "twitter_thread"
  | "email_snippet"
  | "blog_excerpt"
  | "quote_graphic"

export interface PipelineConfig {
  id?: string
  pipelineName: string
  sourceType: SourceType
  outputFormats: OutputFormat[]
  autoApprove?: boolean
  brandVoiceOverride?: string
  hashtagPresets?: string[]
}

export interface PipelineExecution {
  pipelineId: string
  sourceId: string
  brokerageId: string
  userId: string
  teamId?: string
  agentUserId?: string
}

export interface RepurposedOutput {
  outputType: OutputFormat
  outputRefTable: string
  outputRefId: string
  platform: string
  contentPreview: string
  status: "pending" | "approved" | "rejected" | "published"
}

export interface ExecutePipelineResult {
  success: boolean
  pipelineId?: string
  outputs?: RepurposedOutput[]
  error?: string
  blockedReason?: string
}

export interface SavePipelineResult {
  success: boolean
  pipelineId?: string
  error?: string
}

// Platform configuration for output formats
const OUTPUT_FORMAT_CONFIG: Record<OutputFormat, {
  displayName: string
  platform: string
  maxDuration?: number
  aspectRatio?: string
  maxLength?: number
  outputTable: string
}> = {
  instagram_reels: { 
    displayName: "Instagram Reels", 
    platform: "instagram", 
    maxDuration: 90, 
    aspectRatio: "9:16",
    outputTable: "video_snippets"
  },
  instagram_story: { 
    displayName: "Instagram Story", 
    platform: "instagram", 
    maxDuration: 60, 
    aspectRatio: "9:16",
    outputTable: "video_snippets"
  },
  instagram_carousel: { 
    displayName: "Instagram Carousel", 
    platform: "instagram",
    maxLength: 2200,
    outputTable: "social_posts"
  },
  tiktok: { 
    displayName: "TikTok", 
    platform: "tiktok", 
    maxDuration: 180, 
    aspectRatio: "9:16",
    outputTable: "video_snippets"
  },
  youtube_shorts: { 
    displayName: "YouTube Shorts", 
    platform: "youtube", 
    maxDuration: 60, 
    aspectRatio: "9:16",
    outputTable: "video_snippets"
  },
  facebook_reels: { 
    displayName: "Facebook Reels", 
    platform: "facebook", 
    maxDuration: 90, 
    aspectRatio: "9:16",
    outputTable: "video_snippets"
  },
  linkedin_post: { 
    displayName: "LinkedIn Post", 
    platform: "linkedin",
    maxLength: 3000,
    outputTable: "social_posts"
  },
  twitter_thread: { 
    displayName: "Twitter/X Thread", 
    platform: "twitter",
    maxLength: 280,
    outputTable: "social_posts"
  },
  email_snippet: { 
    displayName: "Email Snippet", 
    platform: "email",
    maxLength: 500,
    outputTable: "repurposed_content_log"
  },
  blog_excerpt: { 
    displayName: "Blog Excerpt", 
    platform: "blog",
    maxLength: 1000,
    outputTable: "repurposed_content_log"
  },
  quote_graphic: { 
    displayName: "Quote Graphic", 
    platform: "multi",
    maxLength: 150,
    outputTable: "marketing_assets"
  },
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Execute a repurpose pipeline for a given source content.
 * 
 * Kernel wiring:
 * - Step 1: canAccessFeature('omnipresence_repurposer')
 * - Step 2: applyBrandVoice to generated content
 * - Step 3: evaluateOutbound for compliance check
 * - Step 4: processKernelEvent for OMNIPRESENCE_PIPELINE_STARTED/COMPLETED
 */
export async function executePipeline(
  execution: PipelineExecution
): Promise<ExecutePipelineResult> {
  const supabase = await createClient()
  const { pipelineId, sourceId, brokerageId, userId, teamId, agentUserId } = execution

  // ── STEP 1: Feature Access Check ─────────────────────────────────────────────
  const featureCheck = await canAccessFeature(userId, "omnipresence_repurposer")
  if (!featureCheck.allowed) {
    return {
      success: false,
      error: featureCheck.reason || "Feature access denied",
      blockedReason: featureCheck.reason,
    }
  }

  // Validate IDs
  if (!isValidUUID(pipelineId) || !isValidUUID(sourceId)) {
    return { success: false, error: "Invalid pipeline or source ID" }
  }

  // Load pipeline configuration
  const { data: pipeline, error: pipelineError } = await supabase
    .from("repurpose_pipelines")
    .select("*")
    .eq("id", pipelineId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (pipelineError || !pipeline) {
    return { success: false, error: "Pipeline not found" }
  }

  if (!pipeline.is_active) {
    return { success: false, error: "Pipeline is not active" }
  }

  // Fire PIPELINE_STARTED event
  await processKernelEvent({
    event: KernelEvent.OMNIPRESENCE_PIPELINE_STARTED,
    brokerageId,
    entityType: "repurpose_pipeline",
    entityId: pipelineId,
    metadata: {
      source_type: pipeline.source_type,
      source_id: sourceId,
      output_count: (pipeline.output_config as any)?.formats?.length || 0,
    },
  }).catch((err) => console.error("[pipeline-executor] STARTED event failed:", err))

  // Load source content
  const sourceContent = await loadSourceContent(
    supabase,
    pipeline.source_type as SourceType,
    sourceId,
    brokerageId
  )

  if (!sourceContent) {
    return { success: false, error: "Source content not found" }
  }

  // Get output formats from pipeline config
  const outputConfig = pipeline.output_config as { formats?: OutputFormat[] } | null
  const outputFormats = outputConfig?.formats || []

  if (outputFormats.length === 0) {
    return { success: false, error: "No output formats configured" }
  }

  const outputs: RepurposedOutput[] = []
  const errors: string[] = []

  // Process each output format
  for (const outputFormat of outputFormats) {
    try {
      const result = await generateOutputForFormat({
        supabase,
        sourceContent,
        sourceType: pipeline.source_type as SourceType,
        sourceId,
        outputFormat,
        brokerageId,
        userId,
        teamId,
        agentUserId,
        autoApprove: (pipeline.output_config as any)?.auto_approve ?? false,
      })

      if (result) {
        outputs.push(result)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error"
      errors.push(`${outputFormat}: ${msg}`)
      console.error(`[pipeline-executor] Failed to generate ${outputFormat}:`, err)
    }
  }

  // Fire PIPELINE_COMPLETED event
  await processKernelEvent({
    event: KernelEvent.OMNIPRESENCE_PIPELINE_COMPLETED,
    brokerageId,
    entityType: "repurpose_pipeline",
    entityId: pipelineId,
    metadata: {
      source_id: sourceId,
      outputs_created: outputs.length,
      outputs_failed: errors.length,
    },
  }).catch((err) => console.error("[pipeline-executor] COMPLETED event failed:", err))

  // Increment feature usage
  await incrementFeatureUsage(userId, "omnipresence_repurposer")

  // Revalidate relevant paths
  revalidatePath("/dashboard/campaigns/repurpose")
  revalidatePath("/dashboard/videos/snippets")
  revalidatePath("/social-planner")

  return {
    success: true,
    pipelineId,
    outputs,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  }
}

/**
 * Save or update a repurpose pipeline configuration.
 */
export async function savePipeline(
  userId: string,
  brokerageId: string,
  config: PipelineConfig,
  teamId?: string,
  agentUserId?: string,
  visibilityScope: "brokerage" | "team" | "agent" = "brokerage"
): Promise<SavePipelineResult> {
  const supabase = await createClient()

  // Feature access check
  const featureCheck = await canAccessFeature(userId, "omnipresence_repurposer")
  if (!featureCheck.allowed) {
    return {
      success: false,
      error: featureCheck.reason || "Feature access denied",
    }
  }

  const outputConfig = {
    formats: config.outputFormats,
    auto_approve: config.autoApprove ?? false,
    brand_voice_override: config.brandVoiceOverride ?? null,
    hashtag_presets: config.hashtagPresets ?? [],
  }

  if (config.id && isValidUUID(config.id)) {
    // Update existing pipeline
    const { data, error } = await supabase
      .from("repurpose_pipelines")
      .update({
        pipeline_name: config.pipelineName,
        source_type: config.sourceType,
        output_config: outputConfig,
        updated_at: new Date().toISOString(),
      })
      .eq("id", config.id)
      .eq("brokerage_id", brokerageId)
      .select()
      .single()

    if (error) {
      console.error("[pipeline-executor] Update failed:", error)
      return { success: false, error: error.message }
    }

    revalidatePath("/dashboard/campaigns/repurpose")
    return { success: true, pipelineId: data.id }
  }

  // Create new pipeline
  const { data, error } = await supabase
    .from("repurpose_pipelines")
    .insert({
      brokerage_id: brokerageId,
      team_id: teamId ?? null,
      agent_user_id: agentUserId ?? null,
      created_by: userId,
      visibility_scope: visibilityScope,
      pipeline_name: config.pipelineName,
      source_type: config.sourceType,
      output_config: outputConfig,
      is_active: true,
    })
    .select()
    .single()

  if (error) {
    console.error("[pipeline-executor] Insert failed:", error)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/campaigns/repurpose")
  return { success: true, pipelineId: data.id }
}

/**
 * Get all pipelines for a brokerage.
 */
export async function getPipelines(brokerageId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("repurpose_pipelines")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[pipeline-executor] Failed to fetch pipelines:", error)
    return []
  }

  return data || []
}

/**
 * Get recent repurposed content logs.
 */
export async function getRepurposeHistory(
  brokerageId: string,
  limit = 50
) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("repurposed_content_log")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("[pipeline-executor] Failed to fetch history:", error)
    return []
  }

  return data || []
}

/**
 * Toggle pipeline active status.
 */
export async function togglePipelineActive(
  userId: string,
  pipelineId: string,
  brokerageId: string,
  isActive: boolean
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  const { error } = await supabase
    .from("repurpose_pipelines")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", pipelineId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/campaigns/repurpose")
  return { success: true }
}

/**
 * Delete a pipeline.
 */
export async function deletePipeline(
  userId: string,
  pipelineId: string,
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  const { error } = await supabase
    .from("repurpose_pipelines")
    .delete()
    .eq("id", pipelineId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/campaigns/repurpose")
  return { success: true }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

interface SourceContent {
  title: string
  body: string
  mediaUrl?: string
  duration?: number
  metadata?: Record<string, any>
}

async function loadSourceContent(
  supabase: any,
  sourceType: SourceType,
  sourceId: string,
  brokerageId: string
): Promise<SourceContent | null> {
  switch (sourceType) {
    case "video_project": {
      const { data } = await supabase
        .from("ai_video_projects")
        .select("title, script_content, video_url, duration_seconds")
        .eq("id", sourceId)
        .single()
      if (!data) return null
      return {
        title: data.title || "Untitled Video",
        body: data.script_content || "",
        mediaUrl: data.video_url,
        duration: data.duration_seconds,
      }
    }
    case "blog_post": {
      const { data } = await supabase
        .from("blog_posts")
        .select("title, content, featured_image_url")
        .eq("id", sourceId)
        .eq("brokerage_id", brokerageId)
        .single()
      if (!data) return null
      return {
        title: data.title || "Untitled Blog",
        body: data.content || "",
        mediaUrl: data.featured_image_url,
      }
    }
    case "podcast_episode": {
      const { data } = await supabase
        .from("podcast_episodes")
        .select("title, description, script, audio_url, duration_seconds")
        .eq("id", sourceId)
        .eq("brokerage_id", brokerageId)
        .single()
      if (!data) return null
      return {
        title: data.title || "Untitled Podcast",
        body: data.script || data.description || "",
        mediaUrl: data.audio_url,
        duration: data.duration_seconds,
      }
    }
    case "social_post": {
      const { data } = await supabase
        .from("social_posts")
        .select("content, media_urls, hashtags")
        .eq("id", sourceId)
        .eq("brokerage_id", brokerageId)
        .single()
      if (!data) return null
      return {
        title: "Social Post",
        body: data.content || "",
        mediaUrl: data.media_urls?.[0],
        metadata: { hashtags: data.hashtags },
      }
    }
    case "script": {
      const { data } = await supabase
        .from("video_scripts_library")
        .select("title, script_content")
        .eq("id", sourceId)
        .eq("brokerage_id", brokerageId)
        .single()
      if (!data) return null
      return {
        title: data.title || "Untitled Script",
        body: data.script_content || "",
      }
    }
    case "newsletter": {
      const { data } = await supabase
        .from("newsletter_campaigns")
        .select("campaign_name, subject_line, content")
        .eq("id", sourceId)
        .eq("brokerage_id", brokerageId)
        .single()
      if (!data) return null
      return {
        title: data.subject_line || data.campaign_name || "Untitled Newsletter",
        body: data.content || "",
      }
    }
    default:
      return null
  }
}

async function generateOutputForFormat(params: {
  supabase: any
  sourceContent: SourceContent
  sourceType: SourceType
  sourceId: string
  outputFormat: OutputFormat
  brokerageId: string
  userId: string
  teamId?: string
  agentUserId?: string
  autoApprove: boolean
}): Promise<RepurposedOutput | null> {
  const {
    supabase,
    sourceContent,
    sourceType,
    sourceId,
    outputFormat,
    brokerageId,
    userId,
    teamId,
    agentUserId,
    autoApprove,
  } = params

  const config = OUTPUT_FORMAT_CONFIG[outputFormat]
  if (!config) return null

  // ── STEP 2: Generate content with brand voice ────────────────────────────────
  let generatedContent = await generateContentForPlatform({
    sourceContent,
    outputFormat,
    maxLength: config.maxLength,
  })

  // Apply brand voice transformation
  const brandVoiceResult = await applyBrandVoice(
    generatedContent,
    brokerageId,
    agentUserId,
    teamId
  )
  if (brandVoiceResult.success && brandVoiceResult.transformed) {
    generatedContent = brandVoiceResult.transformed
  }

  // ── STEP 3: Compliance check ─────────────────────────────────────────────────
  const complianceResult = await evaluateOutbound({
    brokerageId,
    actorUserId: userId,
    actorRole: "agent",
    messageType: "social_post",
    content: generatedContent,
    entityType: "repurposed_content",
    entityId: sourceId,
  })

  if (!complianceResult.allowed) {
    console.warn(`[pipeline-executor] Compliance blocked for ${outputFormat}:`, complianceResult.blockedReason)
    // Log the blocked attempt
    await supabase.from("repurposed_content_log").insert({
      brokerage_id: brokerageId,
      source_type: sourceType,
      source_id: sourceId,
      output_type: outputFormat,
      output_ref_table: "compliance_blocked",
      output_ref_id: "00000000-0000-0000-0000-000000000000",
      platform_target: config.platform,
      status: "blocked",
      approval_status: "rejected",
      notes: complianceResult.blockedReason,
      created_by: userId,
    })
    return null
  }

  // Create output record based on format type
  let outputRefId: string
  let outputRefTable = config.outputTable

  if (config.outputTable === "video_snippets" && sourceContent.duration) {
    // Create video snippet
    const aspectRatio = config.aspectRatio || "9:16"
    const maxDuration = config.maxDuration || 60
    const snippetDuration = Math.min(maxDuration, sourceContent.duration)

    const { data: snippet, error } = await supabase
      .from("video_snippets")
      .insert({
        brokerage_id: brokerageId,
        video_project_id: sourceType === "video_project" ? sourceId : null,
        source_video_asset_id: null,
        snippet_title: `${sourceContent.title} - ${config.displayName}`,
        start_seconds: 0,
        end_seconds: snippetDuration,
        aspect_ratio: aspectRatio,
        platform_target: outputFormat,
        caption_text: generatedContent,
        hashtags: extractHashtags(generatedContent),
        approval_status: autoApprove ? "approved" : "pending",
        created_by: userId,
      })
      .select()
      .single()

    if (error) throw error
    outputRefId = snippet.id
  } else if (config.outputTable === "social_posts") {
    // Create social post draft
    const { data: post, error } = await supabase
      .from("social_posts")
      .insert({
        brokerage_id: brokerageId,
        user_id: userId,
        agent_id: agentUserId,
        platform: config.platform,
        post_type: outputFormat,
        content: generatedContent,
        hashtags: extractHashtags(generatedContent),
        media_urls: sourceContent.mediaUrl ? [sourceContent.mediaUrl] : [],
        status: "draft",
        approval_status: autoApprove ? "approved" : "pending",
      })
      .select()
      .single()

    if (error) throw error
    outputRefId = post.id
  } else {
    // Generic log entry for other types
    const { data: log, error } = await supabase
      .from("repurposed_content_log")
      .insert({
        brokerage_id: brokerageId,
        source_type: sourceType,
        source_id: sourceId,
        output_type: outputFormat,
        output_ref_table: "inline",
        output_ref_id: "00000000-0000-0000-0000-000000000000",
        platform_target: config.platform,
        status: "created",
        approval_status: autoApprove ? "approved" : "pending",
        notes: generatedContent,
        created_by: userId,
      })
      .select()
      .single()

    if (error) throw error
    outputRefId = log.id
    outputRefTable = "repurposed_content_log"
  }

  // Log the repurposing in the audit trail
  if (outputRefTable !== "repurposed_content_log") {
    await supabase.from("repurposed_content_log").insert({
      brokerage_id: brokerageId,
      source_type: sourceType,
      source_id: sourceId,
      output_type: outputFormat,
      output_ref_table: outputRefTable,
      output_ref_id: outputRefId,
      platform_target: config.platform,
      status: "created",
      approval_status: autoApprove ? "approved" : "pending",
      created_by: userId,
    })
  }

  return {
    outputType: outputFormat,
    outputRefTable,
    outputRefId,
    platform: config.platform,
    contentPreview: generatedContent.substring(0, 200),
    status: autoApprove ? "approved" : "pending",
  }
}

async function generateContentForPlatform(params: {
  sourceContent: SourceContent
  outputFormat: OutputFormat
  maxLength?: number
}): Promise<string> {
  const { sourceContent, outputFormat, maxLength } = params
  const config = OUTPUT_FORMAT_CONFIG[outputFormat]

  const prompt = `You are a social media expert for real estate. Transform this content for ${config.displayName}.

SOURCE TITLE: ${sourceContent.title}
SOURCE CONTENT:
${sourceContent.body.substring(0, 2000)}

PLATFORM: ${config.displayName}
${maxLength ? `MAX LENGTH: ${maxLength} characters` : ""}

Requirements:
- Make it engaging and platform-native
- Include a compelling hook
- Use natural language, not robotic
- For real estate content, highlight value and urgency
- Include relevant hashtags at the end (3-5 hashtags)

Respond with ONLY the final content text, no explanation.`

  try {
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt,
    })

    let content = text.trim()
    if (maxLength && content.length > maxLength) {
      content = content.substring(0, maxLength - 3) + "..."
    }

    return content
  } catch (err) {
    console.error("[pipeline-executor] AI generation failed:", err)
    // Fallback to simple truncation
    const fallback = `${sourceContent.title}\n\n${sourceContent.body}`
    return fallback.substring(0, maxLength || 500)
  }
}

function extractHashtags(content: string): string[] {
  const hashtagRegex = /#[\w]+/g
  const matches = content.match(hashtagRegex) || []
  return matches.map((h) => h.replace("#", "")).slice(0, 10)
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export { OUTPUT_FORMAT_CONFIG }
