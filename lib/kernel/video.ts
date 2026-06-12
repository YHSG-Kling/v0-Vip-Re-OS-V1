// lib/kernel/video.ts
// Video Generation Kernel - 9 canonical commands following Kernel OS architecture
// All operations route through this layer with explicit input/output contracts
// No escape paths for direct provider calls

import { createClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { dispatchVideo } from "@/lib/providers/dispatch"
import { generateTextRouted } from "@/lib/ai/models"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

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
  avatarId: string
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

  if (!input.avatarId) {
    throw new Error("avatarId is required for video generation. Select an avatar from the library.")
  }

  // Fetch project to get tenant attribution for dispatch
  const { data: project, error: projectError } = await supabase
    .from("ai_video_projects")
    .select("brokerage_id")
    .eq("id", input.projectId)
    .maybeSingle()
  if (projectError) {
    throw new Error(`Cannot submit video: failed to load project — ${projectError.message}`)
  }
  if (!project?.brokerage_id) {
    throw new Error("Cannot submit video: project not found or missing tenant context")
  }
  const brokerageId = project.brokerage_id

  // Atomically claim the project slot. provider_status is the canonical column;
  // we keep heygen_status synced for legacy readers (the poll-heygen-videos
  // cron and the dashboard UI still consume it).
  const { data: reserved, error: preMarkError } = await supabase
    .from("ai_video_projects")
    .update({
      status:          "generating",
      provider_status: "submitting",
      heygen_status:   "submitting",
      updated_at:      new Date().toISOString(),
    })
    .eq("id", input.projectId)
    .neq("status", "generating")
    .neq("status", "submitting")
    .select("id")
  if (preMarkError) {
    throw new Error(`Cannot submit video: failed to reserve project slot — ${preMarkError.message}`)
  }
  if (!reserved?.length) {
    throw new Error("Video generation is already in progress for this project")
  }

  // Submit via the platform vendor selector — dispatchVideo picks D-ID or
  // HeyGen per getPlatformVideoProvider(), so the kernel no longer hard-codes
  // a vendor. Returns the provider's job id regardless of which one rendered.
  let providerJobId: string
  try {
    providerJobId = await submitViaPlatformVendor({
      script:                 input.scriptText,
      voiceProfileId:         input.voiceProfileId,
      avatarId:               input.avatarId,
      estimatedDurationSeconds: input.estimatedDurationSeconds,
      brokerageId,
    })
  } catch (dispatchErr) {
    await supabase
      .from("ai_video_projects")
      .update({
        status:          "setup",
        provider_status: null,
        heygen_status:   null,
        updated_at:      new Date().toISOString(),
      })
      .eq("id", input.projectId)
    throw dispatchErr
  }

  // Persist on the canonical columns; keep heygen_* synced for legacy callers.
  // The video_provider column is the source of truth for which vendor rendered.
  const { error } = await supabase
    .from("ai_video_projects")
    .update({
      provider_job_id: providerJobId,
      provider_status: "queued",
      heygen_video_id: providerJobId,
      heygen_status:   "queued",
      status:          "generating",
      updated_at:      new Date().toISOString(),
    })
    .eq("id", input.projectId)

  if (error) {
    console.error(`[VideoKernel] ORPHANED provider job ${providerJobId} — DB update failed:`, error.message)
    throw new Error(`Failed to persist video job: ${error.message}`)
  }

  return {
    projectId: input.projectId,
    jobId:     providerJobId,
    status:    "queued",
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

  const distributions: { channel: string; status: "pending" | "published" | "failed"; url?: string; error?: string }[] = []

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

      // Schedule the post for the real publisher cron (publish-social-posts),
      // which performs the actual platform publish via lib/social/publisher.ts
      // and records external_post_id + published_at. We do NOT fabricate a
      // published URL — the post goes out as 'scheduled'/'approved' and the cron
      // owns the live publish + URL.
      const { error: postError } = await supabase.from("social_posts").insert({
        brokerage_id: project.brokerage_id,
        agent_id: project.agent_id,
        social_account_id: account.id,
        platform: channel,
        post_type: "custom",
        content: input.description,
        media_urls: [project.video_url],
        hashtags: input.tags ?? [],
        listing_id: project.listing_id ?? null,
        status: "scheduled",
        approval_status: "approved",
        scheduled_for: new Date().toISOString(),
        ai_generated: true,
        created_at: new Date().toISOString(),
      })

      if (postError) {
        distributions.push({ channel, status: "failed", error: postError.message })
        continue
      }

      // Queued for the publisher cron — not yet live on the platform.
      distributions.push({ channel, status: "pending" })
    } catch (err) {
      distributions.push({
        channel,
        status: "failed",
        error: err instanceof Error ? err.message : "Unknown error",
      })
    }
  }

  // Mark the project distributed (posts now carry their own publish lifecycle).
  await supabase
    .from("ai_video_projects")
    .update({
      status: "distributed",
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
  _input: RepurposeVideoOutputInput
): Promise<RepurposeVideoOutputOutput> {
  // No video-processing backend (shorts/clips/thumbnail generation) is wired
  // yet. The prior implementation fabricated artifact URLs by appending
  // ?format=… to the source video, which would surface "clips" that don't
  // exist. Fail honestly until a real processor (e.g. an ffmpeg/Shotstack
  // worker) is connected, rather than returning fake artifacts.
  throw new Error("Video repurposing (shorts/clips/thumbnails) is not yet available")
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

  // Aggregate analytics from social posts. social_posts stores media as a
  // media_urls array and metrics in engagement_data (there is no media_url /
  // engagement_metrics column).
  const { data: posts } = await supabase
    .from("social_posts")
    .select("engagement_data")
    .contains("media_urls", [project.video_url])

  let totalViews = 0
  let totalEngagement = 0
  let totalComments = 0
  let totalShares = 0

  for (const post of posts || []) {
    const metrics = (post.engagement_data || {}) as Record<string, number>
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
  const durationLabel = params.durationSeconds >= 60
    ? `${Math.floor(params.durationSeconds / 60)}-minute`
    : `${params.durationSeconds}-second`

  const prompt = `You are an expert real estate video scriptwriter creating a ${durationLabel} property video script.

Title: "${params.title}"${params.description ? `\nContext: ${params.description}` : ""}
Strategy: ${params.strategy}
Tone: ${params.tone}

Write a scene-by-scene script with timestamps, narration, and visual direction.
Format each scene as:
[Scene N - M:SS-M:SS]
<visual direction>
<narration text>

Focus on viewer benefits — what the home means for their life — not feature lists.
Keep narration natural and conversational.`

  const { text } = await generateTextRouted({
    prompt,
    feature: "video_script_generation",
    maxTokens: 1200,
    temperature: 0.7,
  })
  return text
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

/**
 * Submit a render job via the platform vendor selector. dispatchVideo() reads
 * getPlatformVideoProvider() and routes to D-ID (default) or HeyGen (super-
 * admin override). Returns the provider's job id regardless of which vendor
 * rendered — the caller persists it to provider_job_id.
 *
 * Previously this function was named submitToHeyGen() which falsely implied
 * a HeyGen-only path even though it has gone through dispatchVideo since the
 * D-ID-first refactor. Renamed for clarity.
 */
async function submitViaPlatformVendor(params: {
  script: string
  voiceProfileId: string
  avatarId: string
  estimatedDurationSeconds: number
  brokerageId: string
}): Promise<string> {
  if (!params.avatarId || params.avatarId.trim().length < 1) {
    throw new Error("avatarId is required to submit a video render job")
  }
  const result = await dispatchVideo({
    brokerageId:    params.brokerageId,
    templateId:     params.avatarId,
    recipientEmail: "system@internal",
    scriptVars: {
      script:           params.script,
      voice_profile_id: params.voiceProfileId,
      duration_seconds: String(params.estimatedDurationSeconds),
    },
    systemSource: "video_kernel",
  })
  if (!result.success) throw new Error(result.error ?? "Video provider submission failed")
  const jobId = result.messageId
  if (!jobId) throw new Error("Video provider returned no job id — cannot track job")
  return jobId
}

// HeyGen is not used (D-ID + ElevenLabs only) — no new HeyGen jobs are created, so
// this polls nothing. Retained as a no-op only for any ancient in-flight
// heygen_status='processing' rows; it makes ZERO network calls to api.heygen.com.
// New projects track D-ID via provider_status / provider_job_id.
async function checkHeyGenJobStatus(_jobId: string): Promise<{
  status: string
  videoUrl?: string
}> {
  return { status: "unknown" }
}

// ============================================================================
// GATED COORDINATED DISTRIBUTION (inter-manager bus)
// ============================================================================

/**
 * GATED, off-request video distribution proposal — used by the Campaign Orchestrator
 * when it consumes a `video_ready` signal from the Asset Manager.
 *
 * Unlike distributeVideoProject() (the user-initiated publish path, which inserts
 * social_posts as status='scheduled'/approval_status='approved' so the publisher cron
 * sends them), this proposes ONE multi-channel draft (status='draft',
 * approval_status='pending', platform='all') that NEVER auto-publishes — a human must
 * approve it in the Command Center first. It mirrors the gated marketing-bench pattern
 * (no connected social account required at draft time; the account is bound at publish).
 *
 * Idempotent per project: skips if a draft already carries this project's video as media.
 * Takes a caller-supplied service client so it runs from the signal handler (no request).
 */
export async function proposeGatedVideoDistribution(
  input: {
    brokerageId: string
    projectId: string
    title: string
    description: string
    tags?: string[]
  },
  client: SupabaseClient,
): Promise<{ ok: boolean; created: boolean; reason?: string; postId?: string }> {
  const supabase = client

  const { data: project, error: projErr } = await supabase
    .from("ai_video_projects")
    .select("id, brokerage_id, agent_id, listing_id, marketing_campaign_id, video_url, status")
    .eq("id", input.projectId)
    .maybeSingle()
  if (projErr) return { ok: false, created: false, reason: projErr.message }
  if (!project || !(project as any).video_url) {
    return { ok: false, created: false, reason: "video not ready (no video_url)" }
  }
  const videoUrl = (project as any).video_url as string

  // Idempotency — skip if a draft for this project's video already exists.
  const { data: existing } = await supabase
    .from("social_posts")
    .select("id")
    .eq("brokerage_id", input.brokerageId)
    .contains("media_urls", [videoUrl])
    .limit(1)
    .maybeSingle()
  if (existing) {
    return { ok: true, created: false, reason: "draft already exists for this project", postId: (existing as any).id }
  }

  // ONE multi-channel gated draft. platform='all' mirrors marketing-bench's
  // coordinated-stage pattern; a human picks/approves channels at the gate.
  const { data: inserted, error } = await supabase
    .from("social_posts")
    .insert({
      brokerage_id:          input.brokerageId,
      // NOTE: ai_video_projects.agent_id FKs users.id, but social_posts.agent_id FKs
      // agents.id — they are different id-spaces. Leave null on the gated draft (the
      // agent + connected social account are bound at approval/publish time, mirroring
      // the gated marketing-bench pattern) rather than cross-wire mismatched ids.
      agent_id:              null,
      listing_id:            (project as any).listing_id ?? null,
      marketing_campaign_id: (project as any).marketing_campaign_id ?? null,
      platform:              "all",
      post_type:             "custom",
      content:               input.description,
      media_urls:            [videoUrl],
      hashtags:              input.tags ?? [],
      status:                "draft",
      approval_status:       "pending",
      ai_generated:          true,
      post_brief:            `Coordinated video distribution proposed by the Campaign Orchestrator from a finished render: ${input.title}`,
      created_at:            new Date().toISOString(),
    })
    .select("id")
    .maybeSingle()
  if (error || !inserted) return { ok: false, created: false, reason: error?.message ?? "insert failed" }
  return { ok: true, created: true, postId: (inserted as any).id }
}

