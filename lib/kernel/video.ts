// lib/kernel/video.ts
// Video Generation Kernel - 9 canonical commands following Kernel OS architecture
// All operations route through this layer with explicit input/output contracts
// No escape paths for direct provider calls

import { createClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"

// ============================================================================
// TYPES & CONTRACTS
// ============================================================================

export interface CreateVideoProjectInput {
  agentId: string
  brokerageId: string
  title: string
  description?: string
  campaignId?: string
  sourceType: "property" | "campaign" | "manual"
  sourceId?: string
}

export interface CreateVideoProjectOutput {
  projectId: string
  status: "setup" | "scripting" | "generating" | "ready" | "published"
  createdAt: string
}

export interface GenerateVideoScriptInput {
  projectId: string
  contentStrategy: "luxury_showcase" | "walkthrough" | "testimonial" | "market_update"
  tone: "professional" | "friendly" | "energetic"
  duration: 30 | 60 | 90
}

export interface GenerateVideoScriptOutput {
  projectId: string
  scriptText: string
  wordCount: number
  estimatedDuration: number
  aiConfidence: number
  scenes: Array<{ duration: number; description: string }>
}

export interface UpdateVideoGenerationSettingsInput {
  projectId: string
  voiceProfileId: string
  avatarStyle: "professional" | "casual" | "luxury"
  musicTrack?: string
  subtitles: boolean
  watermark: boolean
}

export interface UpdateVideoGenerationSettingsOutput {
  projectId: string
  settingsApplied: boolean
  updatedAt: string
}

export interface SubmitVideoGenerationJobInput {
  projectId: string
  scriptText: string
  voiceProfileId: string
  avatarStyle: string
  estimatedDurationSeconds: number
}

export interface SubmitVideoGenerationJobOutput {
  projectId: string
  jobId: string
  status: "queued" | "processing"
  estimatedCompletionMinutes: number
}

export interface LoadVideoGenerationStateInput {
  projectId: string
}

export interface LoadVideoGenerationStateOutput {
  projectId: string
  status: string
  scriptText?: string
  settings?: Record<string, unknown>
  heygenStatus?: string
  videoUrl?: string
  createdAt: string
  updatedAt: string
}

export interface PreviewVideoProjectInput {
  projectId: string
}

export interface PreviewVideoProjectOutput {
  streamUrl: string
  duration: number
  thumbnail?: string
}

export interface DistributeVideoProjectInput {
  projectId: string
  channels: Array<"youtube" | "linkedin" | "tiktok" | "instagram">
  title: string
  description: string
  tags?: string[]
}

export interface DistributeVideoProjectOutput {
  projectId: string
  distributions: Array<{
    channel: string
    status: "pending" | "published" | "failed"
    url?: string
    error?: string
  }>
}

export interface RepurposeVideoOutputInput {
  projectId: string
  formats: Array<"shorts" | "clips" | "thumbnail" | "description">
}

export interface RepurposeVideoOutputOutput {
  projectId: string
  artifacts: Array<{
    format: string
    url: string
    duration?: number
  }>
}

export interface LoadVideoPerformanceInput {
  projectId: string
}

export interface LoadVideoPerformanceOutput {
  projectId: string
  views: number
  engagement: number
  comments: number
  shares: number
  generatedAt: string
}

// ============================================================================
// KERNEL COMMANDS (9 total)
// ============================================================================

/**
 * 1. CREATE VIDEO PROJECT
 * Input: CreateVideoProjectInput { agentId, brokerageId, title, ... }
 * Output: CreateVideoProjectOutput { projectId, status, createdAt }
 * Database: INSERT into ai_video_projects
 */
export async function createVideoProject(
  input: CreateVideoProjectInput
): Promise<CreateVideoProjectOutput> {
  const supabase = await createClient()

  const { data: project, error } = await supabase
    .from("ai_video_projects")
    .insert({
      agent_id: input.agentId,
      brokerage_id: input.brokerageId,
      title: input.title,
      description: input.description,
      campaign_id: input.campaignId,
      source_type: input.sourceType,
      source_id: input.sourceId,
      status: "setup",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
    .maybeSingle()

  if (error || !project) {
    throw new Error(`Failed to create video project: ${error?.message}`)
  }

  return {
    projectId: project.id,
    status: project.status,
    createdAt: project.created_at,
  }
}

/**
 * 2. GENERATE VIDEO SCRIPT
 * Input: GenerateVideoScriptInput { projectId, contentStrategy, tone, duration }
 * Output: GenerateVideoScriptOutput { scriptText, scenes, aiConfidence }
 * Database: UPDATE ai_video_projects with script
 */
export async function generateVideoScript(
  input: GenerateVideoScriptInput
): Promise<GenerateVideoScriptOutput> {
  const supabase = await createClient()

  // Fetch project
  const { data: project, error: projectError } = await supabase
    .from("ai_video_projects")
    .select("*")
    .eq("id", input.projectId)
    .maybeSingle()

  if (projectError || !project) {
    throw new Error(`Video project not found: ${input.projectId}`)
  }

  // Generate script using AI (using openai provider function)
  const scriptText = await generateScriptViaAI({
    title: project.title,
    description: project.description,
    strategy: input.contentStrategy,
    tone: input.tone,
    durationSeconds: input.duration,
  })

  const scenes = parseSceneBreakpoints(scriptText, input.duration)
  const wordCount = scriptText.split(/\s+/).length

  // Update project with script
  const { error: updateError } = await supabase
    .from("ai_video_projects")
    .update({
      script_text: scriptText,
      status: "scripting",
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.projectId)

  if (updateError) {
    throw new Error(`Failed to save script: ${updateError.message}`)
  }

  return {
    projectId: input.projectId,
    scriptText,
    wordCount,
    estimatedDuration: input.duration,
    aiConfidence: 0.92,
    scenes,
  }
}

/**
 * 3. UPDATE VIDEO GENERATION SETTINGS
 * Input: UpdateVideoGenerationSettingsInput { projectId, voiceProfileId, ... }
 * Output: UpdateVideoGenerationSettingsOutput { settingsApplied, updatedAt }
 * Database: UPDATE ai_video_projects provider_metadata
 */
export async function updateVideoGenerationSettings(
  input: UpdateVideoGenerationSettingsInput
): Promise<UpdateVideoGenerationSettingsOutput> {
  const supabase = await createClient()

  const settings = {
    voice_profile_id: input.voiceProfileId,
    avatar_style: input.avatarStyle,
    music_track: input.musicTrack,
    subtitles: input.subtitles,
    watermark: input.watermark,
  }

  const { error } = await supabase
    .from("ai_video_projects")
    .update({
      provider_metadata: settings,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.projectId)

  if (error) {
    throw new Error(`Failed to update settings: ${error.message}`)
  }

  return {
    projectId: input.projectId,
    settingsApplied: true,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 4. SUBMIT VIDEO GENERATION JOB
 * Input: SubmitVideoGenerationJobInput { projectId, scriptText, voiceProfileId, ... }
 * Output: SubmitVideoGenerationJobOutput { jobId, status, estimatedCompletionMinutes }
 * Database: UPDATE ai_video_projects with heygen_job_id
 */
export async function submitVideoGenerationJob(
  input: SubmitVideoGenerationJobInput
): Promise<SubmitVideoGenerationJobOutput> {
  const supabase = await createClient()

  // Call HeyGen API via dispatch
  const heygenJobId = await submitToHeyGen({
    script: input.scriptText,
    voiceProfileId: input.voiceProfileId,
    avatarStyle: input.avatarStyle,
    estimatedDurationSeconds: input.estimatedDurationSeconds,
  })

  // Update project with job ID
  const { error } = await supabase
    .from("ai_video_projects")
    .update({
      heygen_job_id: heygenJobId,
      heygen_status: "queued",
      status: "generating",
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.projectId)

  if (error) {
    throw new Error(`Failed to submit job: ${error.message}`)
  }

  return {
    projectId: input.projectId,
    jobId: heygenJobId,
    status: "queued",
    estimatedCompletionMinutes: Math.ceil(input.estimatedDurationSeconds / 6),
  }
}

/**
 * 5. LOAD VIDEO GENERATION STATE
 * Input: LoadVideoGenerationStateInput { projectId }
 * Output: LoadVideoGenerationStateOutput { full project state }
 * Database: SELECT from ai_video_projects
 */
export async function loadVideoGenerationState(
  input: LoadVideoGenerationStateInput
): Promise<LoadVideoGenerationStateOutput> {
  const supabase = await createClient()

  const { data: project, error } = await supabase
    .from("ai_video_projects")
    .select("*")
    .eq("id", input.projectId)
    .maybeSingle()

  if (error || !project) {
    throw new Error(`Video project not found: ${input.projectId}`)
  }

  // Poll HeyGen if job in progress
  if (project.heygen_status === "processing" && project.heygen_job_id) {
    const status = await checkHeyGenJobStatus(project.heygen_job_id)
    if (status.videoUrl) {
      await supabase
        .from("ai_video_projects")
        .update({
          video_url: status.videoUrl,
          heygen_status: "completed",
          status: "ready",
          updated_at: new Date().toISOString(),
        })
        .eq("id", input.projectId)
    }
  }

  return {
    projectId: project.id,
    status: project.status,
    scriptText: project.script_text,
    settings: project.provider_metadata,
    heygenStatus: project.heygen_status,
    videoUrl: project.video_url,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  }
}

/**
 * 6. PREVIEW VIDEO PROJECT
 * Input: PreviewVideoProjectInput { projectId }
 * Output: PreviewVideoProjectOutput { streamUrl, duration, thumbnail }
 * Database: SELECT from ai_video_projects
 */
export async function previewVideoProject(
  input: PreviewVideoProjectInput
): Promise<PreviewVideoProjectOutput> {
  const supabase = await createClient()

  const { data: project, error } = await supabase
    .from("ai_video_projects")
    .select("*")
    .eq("id", input.projectId)
    .maybeSingle()

  if (error || !project || !project.video_url) {
    throw new Error(`Video not ready for preview: ${input.projectId}`)
  }

  return {
    streamUrl: project.video_url,
    duration: project.duration_seconds || 60,
    thumbnail: project.thumbnail_url,
  }
}

/**
 * 7. DISTRIBUTE VIDEO PROJECT
 * Input: DistributeVideoProjectInput { projectId, channels, title, description }
 * Output: DistributeVideoProjectOutput { distributions array with status }
 * Database: INSERT into social_posts, UPDATE ai_video_projects
 */
export async function distributeVideoProject(
  input: DistributeVideoProjectInput
): Promise<DistributeVideoProjectOutput> {
  const supabase = await createClient()

  const { data: project, error: projectError } = await supabase
    .from("ai_video_projects")
    .select("*")
    .eq("id", input.projectId)
    .maybeSingle()

  if (projectError || !project || !project.video_url) {
    throw new Error(`Video not ready for distribution: ${input.projectId}`)
  }

  const distributions = []

  for (const channel of input.channels) {
    try {
      // Get social account for channel
      const { data: account } = await supabase
        .from("social_media_accounts")
        .select("*")
        .eq("platform", channel)
        .eq("agent_id", project.agent_id)
        .maybeSingle()

      if (!account) {
        distributions.push({
          channel,
          status: "failed",
          error: "No account connected",
        })
        continue
      }

      // Publish to platform via dispatch
      const publishUrl = await publishToChannel({
        platform: channel,
        videoUrl: project.video_url,
        title: input.title,
        description: input.description,
        tags: input.tags,
        accountId: account.id,
      })

      // Record social post
      await supabase.from("social_posts").insert({
        agent_id: project.agent_id,
        platform,
        content: input.description,
        media_url: project.video_url,
        published_url: publishUrl,
        status: "published",
        created_at: new Date().toISOString(),
      })

      distributions.push({
        channel,
        status: "published",
        url: publishUrl,
      })
    } catch (err) {
      distributions.push({
        channel,
        status: "failed",
        error: err instanceof Error ? err.message : "Unknown error",
      })
    }
  }

  // Update project status
  await supabase
    .from("ai_video_projects")
    .update({
      status: "published",
      distribution_channels: input.channels,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.projectId)

  return {
    projectId: input.projectId,
    distributions,
  }
}

/**
 * 8. REPURPOSE VIDEO OUTPUT
 * Input: RepurposeVideoOutputInput { projectId, formats }
 * Output: RepurposeVideoOutputOutput { artifacts array }
 * Database: UPDATE ai_video_projects with repurposed URLs
 */
export async function repurposeVideoOutput(
  input: RepurposeVideoOutputInput
): Promise<RepurposeVideoOutputOutput> {
  const supabase = await createClient()

  const { data: project, error } = await supabase
    .from("ai_video_projects")
    .select("*")
    .eq("id", input.projectId)
    .maybeSingle()

  if (error || !project || !project.video_url) {
    throw new Error(`Video not found: ${input.projectId}`)
  }

  const artifacts = []

  for (const format of input.formats) {
    const url = await generateArtifact(project.video_url, format)
    artifacts.push({
      format,
      url,
      duration: format === "shorts" ? 15 : format === "clips" ? 30 : undefined,
    })
  }

  // Store artifact URLs
  await supabase
    .from("ai_video_projects")
    .update({
      repurposed_artifacts: artifacts,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.projectId)

  return {
    projectId: input.projectId,
    artifacts,
  }
}

/**
 * 9. LOAD VIDEO PERFORMANCE
 * Input: LoadVideoPerformanceInput { projectId }
 * Output: LoadVideoPerformanceOutput { analytics }
 * Database: SELECT from ai_video_projects, aggregated from social_posts
 */
export async function loadVideoPerformance(
  input: LoadVideoPerformanceInput
): Promise<LoadVideoPerformanceOutput> {
  const supabase = await createClient()

  const { data: project, error } = await supabase
    .from("ai_video_projects")
    .select("*")
    .eq("id", input.projectId)
    .maybeSingle()

  if (error || !project) {
    throw new Error(`Video project not found: ${input.projectId}`)
  }

  // Aggregate analytics from social posts
  const { data: posts } = await supabase
    .from("social_posts")
    .select("engagement_metrics")
    .eq("media_url", project.video_url)

  let totalViews = 0
  let totalEngagement = 0
  let totalComments = 0
  let totalShares = 0

  for (const post of posts || []) {
    const metrics = post.engagement_metrics || {}
    totalViews += metrics.views || 0
    totalEngagement += metrics.engagement || 0
    totalComments += metrics.comments || 0
    totalShares += metrics.shares || 0
  }

  return {
    projectId: input.projectId,
    views: totalViews,
    engagement: totalEngagement,
    comments: totalComments,
    shares: totalShares,
    generatedAt: new Date().toISOString(),
  }
}

// ============================================================================
// PRIVATE HELPER FUNCTIONS (No contracts - internal only)
// ============================================================================

async function generateScriptViaAI(params: {
  title: string
  description?: string
  strategy: string
  tone: string
  durationSeconds: number
}): Promise<string> {
  // Use AI SDK provider function - openai or anthropic
  // This is a placeholder that would call the actual AI generation
  return `
[Scene 1 - 0:00-0:15]
Showcase the stunning exterior and curb appeal.
Property highlights: ${params.title}

[Scene 2 - 0:15-0:30]
Virtual tour of the main living areas.
Tour through the spacious rooms.

[Scene 3 - 0:30-0:45]
Kitchen and modern amenities.
State-of-the-art finishes.

[Scene 4 - 0:45-1:00]
Outdoor spaces and property details.
Perfect for entertaining.
  `.trim()
}

function parseSceneBreakpoints(
  script: string,
  totalDuration: number
): Array<{ duration: number; description: string }> {
  const scenes: Array<{ duration: number; description: string }> = []
  const lines = script.split("\n").filter((l) => l.trim())

  const durationPerScene = totalDuration / Math.ceil(lines.length / 2)

  for (let i = 0; i < lines.length; i += 2) {
    scenes.push({
      duration: Math.round(durationPerScene),
      description: lines[i + 1] || lines[i],
    })
  }

  return scenes
}

async function submitToHeyGen(params: {
  script: string
  voiceProfileId: string
  avatarStyle: string
  estimatedDurationSeconds: number
}): Promise<string> {
  // Call HeyGen API - would use actual dispatch provider
  return `job_${Date.now()}`
}

async function checkHeyGenJobStatus(jobId: string): Promise<{
  status: string
  videoUrl?: string
}> {
  // Poll HeyGen API - would use actual dispatch provider
  return { status: "completed", videoUrl: `https://cdn.heygen.com/${jobId}.mp4` }
}

async function publishToChannel(params: {
  platform: string
  videoUrl: string
  title: string
  description: string
  tags?: string[]
  accountId: string
}): Promise<string> {
  // Publish to YouTube/LinkedIn/TikTok - would use actual dispatch provider
  return `https://${params.platform}.com/watch?v=${Date.now()}`
}

async function generateArtifact(
  videoUrl: string,
  format: string
): Promise<string> {
  // Generate shorts/clips/thumbnail - would use actual video processing
  return `${videoUrl}?format=${format}`
}
