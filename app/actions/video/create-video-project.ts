"use server"

import { createClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { generateAvatarVideo, getAvatarVideoStatus } from "@/app/actions/external-services"

// ============================================
// VIDEO PROJECT CREATION — ai_video_projects
// Full lifecycle: script → generate → distribute
// ============================================

export interface CreateVideoProjectParams {
  brokerageId: string
  /**
   * The agent's USERS id — which is what every caller actually holds (ctx.userId,
   * auth.userId, a session user). It was called `agentId` and fed to TWO
   * destinations in different id spaces: resolveVideoProvider, which wants a
   * users id, and ai_video_projects.agent_id, which since m366 is a FK to
   * agents(id). One value cannot be both. Named for what it is, and the
   * users->agents resolve now happens HERE, once, instead of at every caller.
   */
  agentUserId: string
  title: string
  /**
   * The spoken script. Optional ONLY in the two-stage lane below — every caller
   * that intends the project to be renderable still has to supply one, and an
   * empty string is still rejected unless `scriptPending` says so explicitly.
   */
  script?: string
  /**
   * THE SHELL LANE, moved here from lib/kernel/video.ts:createVideoProject.
   * That path created a project with a title and a brief and NO script, at
   * status 'setup', for POST /api/video/projects/[projectId]/script to fill in
   * later (it reads video_metadata.description as the brief). Collapsing the
   * kernel creator into this one would have lost that lane, so it is explicit
   * here rather than inferred from an empty script — a caller that meant to
   * pass a script and passed "" must still get an error, not a silent shell.
   */
  scriptPending?: boolean
  videoType: string
  avatarId?: string
  voiceId?: string
  backgroundType: "solid" | "gradient" | "branded" | "custom" | "property"
  backgroundUrl?: string
  backgroundColorHex?: string
  format: "horizontal" | "square" | "vertical"
  durationSeconds: number
  captionsEnabled: boolean
  listingId?: string
  /**
   * CAMPAIGN ATTRIBUTION — moved here from lib/kernel/video.ts:createVideoProject,
   * which was the only path that carried it. Verified against the live schema:
   *
   *   · marketing_campaign_id is a REAL column (uuid, FK marketing_campaigns(id)
   *     ON DELETE SET NULL), so campaignId is written as a column.
   *   · There is NO source_type and NO source_id column on ai_video_projects.
   *     The kernel folded both into the video_metadata jsonb — note the column
   *     is `video_metadata`, not `metadata` — and so does this.
   *   · description likewise has no column and lives at video_metadata.description,
   *     where lib/kernel/video.ts:generateVideoScript reads it as the AI brief.
   *     It is load-bearing, not decoration.
   */
  campaignId?: string
  sourceType?: "property" | "campaign" | "manual"
  sourceId?: string
  /** Free-text brief. Persisted to video_metadata.description (no column). */
  description?: string
}

export interface VideoProject {
  id: string
  title: string
  script_content: string
  video_type: string
  // 'setup' = created without a script, waiting on the scripting step (the lane
  // inherited from lib/kernel/video.ts). ai_video_projects.status has no CHECK
  // constraint, so this union is the only place the vocabulary is written down.
  status: "setup" | "draft" | "generating" | "ready" | "failed" | "distributed"
  provider_job_id: string | null
  provider_status: string | null
  video_url: string | null
  thumbnail_url: string | null
  error_message: string | null
  background_type: string
  background_url: string | null
  format: string
  duration_seconds: number
  captions_enabled: boolean
  retry_count: number
  created_at: string
  agent_id: string
  brokerage_id: string
  listing_id: string | null
  marketing_campaign_id: string | null
  video_metadata: Record<string, unknown> | null
}

// ─── AI SCRIPT GENERATION ──────────────────────────────────────────────────

export async function generateAIScript(params: {
  description: string
  videoType: "listing_tour" | "market_update" | "agent_intro" | "tips" | "testimonial"
  tone: "professional" | "friendly" | "luxury" | "educational"
  durationSeconds: number
  brokerageId: string
  agentId: string
  listingAddress?: string
  listingPrice?: number
  listingFeatures?: string[]
}) {
  // Word count target: ~150 words per 60s
  const targetWords = Math.round((params.durationSeconds / 60) * 150)

  const typeContext: Record<string, string> = {
    listing_tour: "a property tour walkthrough highlighting the home's best features",
    market_update: "a local real estate market update with current statistics and insights",
    agent_intro: "an agent introduction presenting their expertise and value proposition",
    tips: "actionable real estate tips or advice for buyers and sellers",
    testimonial: "a client success story or testimonial about a positive real estate experience",
  }

  const toneContext: Record<string, string> = {
    professional: "authoritative, polished, and data-driven",
    friendly: "warm, conversational, and approachable",
    luxury: "sophisticated, refined, and aspirational",
    educational: "clear, informative, and helpful",
  }

  let listingContext = ""
  if (params.listingAddress && params.videoType === "listing_tour") {
    listingContext = `
Property details:
- Address: ${params.listingAddress}
- Price: ${params.listingPrice ? `$${params.listingPrice.toLocaleString()}` : "Contact for price"}
- Key features: ${params.listingFeatures?.join(", ") || "available upon request"}
`
  }

  const prompt = `Write a ${params.durationSeconds}-second video script (~${targetWords} words) for ${typeContext[params.videoType]}.

Tone: ${toneContext[params.tone]}
${listingContext}
Topic: ${params.description}

Requirements:
- Open with a strong hook in the first 5 seconds
- Be natural and conversational — this will be spoken by an AI avatar
- Include a clear call-to-action at the end
- NO stage directions, NO camera instructions, NO [PAUSE] markers
- Just the spoken words, ready to be read aloud
- Target exactly ${targetWords} words

Return only the script text.`

  const raw = await generateText({
    prompt,
    feature: "video_script_generation",
    agentId: params.agentId,
    brokerageId: params.brokerageId,
  })

  // Apply brand voice
  const withVoice = await applyBrandVoice({
    content: raw.text,
    brokerageId: params.brokerageId,
    actorUserId: params.agentId,
    actorRole: "agent",
    journeyType: "seller",
    persona: "seller",
    messageType: "social",
  }).then((r) => r.content, () => raw.text)

  // Compliance check
  const scriptContent = typeof withVoice === "string" ? withVoice : raw.text
  const compliance = await evaluateOutbound({
    actorContext: {
      userId: params.agentId,
      role: "agent",
      brokerageId: params.brokerageId,
    },
    journeyType: "buyer",
    persona: "first_time",
    messageType: "social",
    content: scriptContent,
    contact: {
      id: "broadcast",
      first_name: "Broadcast",
      last_name: "Audience",
      contact_type: "buyer",
      tcpa_consent: true,
      isa_reengage_allowed: false,
      dnc_status: false,
    },
  }).catch(() => ({ allowed: true, violations: [] as string[] }))

  return {
    script: scriptContent,
    wordCount: scriptContent.split(/\s+/).filter(Boolean).length,
    complianceAllowed: compliance.allowed,
    complianceViolations: compliance.allowed ? [] : (compliance.violations ?? []),
  }
}

// ─── IMPROVE EXISTING SCRIPT ────────────────────────────────────────────────

export async function improveScript(params: {
  currentScript: string
  improvement: "flow" | "shorter" | "more_engaging" | "luxury" | "friendly"
  brokerageId: string
  agentId: string
}) {
  const improvementPrompts: Record<string, string> = {
    flow: "Rewrite this script for better flow and pacing. Make transitions smoother.",
    shorter: "Condense this script by 30%. Keep only the most impactful points.",
    more_engaging: "Make this script more engaging and dynamic. Add energy and personality.",
    luxury: "Rewrite in a sophisticated, luxury tone. Elevate the language.",
    friendly: "Make this friendlier and more conversational, like talking to a friend.",
  }

  const prompt = `${improvementPrompts[params.improvement]}

Original script:
${params.currentScript}

Return only the improved script text, no explanations.`

  const result = await generateText({
    prompt,
    feature: "video_script_generation",
    agentId: params.agentId,
    brokerageId: params.brokerageId,
  })

  return {
    script: result.text,
    wordCount: result.text.split(/\s+/).filter(Boolean).length,
  }
}

// ─── CREATE VIDEO PROJECT ────────────────────────────────────────────────────

export async function createVideoProject(params: CreateVideoProjectParams): Promise<{
  success: boolean
  project?: VideoProject
  error?: string
}> {
  if (!isValidUUID(params.brokerageId) || !isValidUUID(params.agentUserId)) {
    return { success: false, error: "Invalid brokerage or agent ID" }
  }
  if (!params.title?.trim()) {
    return { success: false, error: "Title is required" }
  }
  if (!params.script?.trim() && !params.scriptPending) {
    return { success: false, error: "Script is required" }
  }

  const supabase = await createClient()

  // CAMPAIGN ATTRIBUTION, tenant-checked. The kernel path wrote the caller's
  // campaignId into marketing_campaign_id unverified, so a caller could attribute
  // its video to ANOTHER brokerage's campaign — the FK only proves the campaign
  // exists, never that it is ours. Resolve it inside the tenant or refuse.
  let marketingCampaignId: string | null = null
  if (params.campaignId) {
    if (!isValidUUID(params.campaignId)) {
      return { success: false, error: "Invalid campaign ID" }
    }
    const { data: campaign, error: campaignError } = await supabase
      .from("marketing_campaigns")
      .select("id")
      .eq("id", params.campaignId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()
    if (campaignError) {
      console.error("[create-video-project] Campaign lookup error:", campaignError)
      return { success: false, error: campaignError.message }
    }
    if (!campaign) {
      return { success: false, error: "Marketing campaign not found in this brokerage" }
    }
    marketingCampaignId = campaign.id
  }

  // Migration 1052: provider resolved (D-ID default; agent + brokerage
  // overrides). Hard-coded 'heygen' before — wrong; @d-id/client-sdk is
  // the primary in package.json and agent_voice_profiles defaults to 'did'.
  const { resolveVideoProvider, initialProviderColumns } = await import("@/lib/marketing/video-provider-resolver")
  const provider = await resolveVideoProvider(supabase, {
    brokerageId: params.brokerageId,
    agentUserId: params.agentUserId,
  })
  const providerCols = initialProviderColumns(provider)

  // ai_video_projects.agent_id FKs agents(id) since m366, so the users id the
  // caller holds has to be RESOLVED, never substituted. The column is NOT NULL,
  // so a user with no agent profile cannot own a video project — say so rather
  // than letting the foreign key phrase it.
  const { resolveAgentIdInBrokerage } = await import("@/lib/kernel/agent-identity")
  const projectAgentId = await resolveAgentIdInBrokerage(supabase, params.agentUserId, params.brokerageId)
  if (!projectAgentId) {
    return { success: false, error: "No agent profile for this user in this brokerage — the video project has no owner to file it under." }
  }

  // ONE jsonb column, several tenants of it — build it up rather than letting a
  // later key overwrite an earlier one. background_color was the only occupant;
  // description / source_type / source_id join it from the kernel path. Written
  // as null (not {}) when empty, which is what this insert did before.
  const videoMetadata: Record<string, unknown> = {}
  if (params.backgroundColorHex) videoMetadata.background_color = params.backgroundColorHex
  if (params.description !== undefined) videoMetadata.description = params.description
  if (params.sourceType !== undefined) videoMetadata.source_type = params.sourceType
  if (params.sourceId !== undefined) videoMetadata.source_id = params.sourceId

  const { data: project, error } = await supabase
    .from("ai_video_projects")
    .insert({
      brokerage_id: params.brokerageId,
      agent_id: projectAgentId,
      title: params.title,
      script_content: params.script ?? null,
      video_type: params.videoType,
      provider_avatar_id: params.avatarId ?? null,
      provider_voice_id: params.voiceId ?? null,
      background_type: params.backgroundType,
      background_url: params.backgroundUrl ?? null,
      video_metadata: Object.keys(videoMetadata).length > 0 ? videoMetadata : null,
      marketing_campaign_id: marketingCampaignId,
      format: params.format,
      duration_seconds: params.durationSeconds,
      captions_enabled: params.captionsEnabled,
      listing_id: params.listingId ?? null,
      // 'setup' is the kernel shell lane's status — the project is waiting for
      // its script. A project created WITH a script is a 'draft', as before.
      status: params.script?.trim() ? "draft" : "setup",
      retry_count: 0,
      video_provider: provider,
      ...providerCols,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
    .maybeSingle()

  if (error || !project) {
    console.error("[create-video-project] Insert error:", error)
    return { success: false, error: error?.message ?? "Failed to create video project" }
  }

  // Emit kernel event. supabase-js RESOLVES a refused insert instead of throwing,
  // so an un-destructured `await` here would have swallowed an RLS refusal and
  // reported a project whose lifecycle event never landed.
  const { error: eventError } = await supabase.from("lifecycle_events").insert({
    entity_type: "video_project",
    entity_id: project.id,
    brokerage_id: params.brokerageId,
    event_type: KernelEvent.VIDEO_GENERATION_REQUESTED,
    // lifecycle_events.actor_user_id is users-class — the caller-supplied users
    // id is the right value here, NOT the resolved agents id above.
    actor_user_id: params.agentUserId,
    metadata: {
      video_type: params.videoType,
      title: params.title,
      campaign_id: marketingCampaignId,
      source_type: params.sourceType ?? null,
      source_id: params.sourceId ?? null,
    },
  })
  if (eventError) {
    console.error("[create-video-project] lifecycle_events insert error:", eventError)
  }

  await processKernelEvent({
    event: KernelEvent.VIDEO_GENERATION_REQUESTED,
    brokerageId: params.brokerageId,
    entityType: "video_project",
    entityId: project.id,
  }).catch(() => {})

  revalidatePath("/dashboard/videos")
  revalidatePath("/dashboard/videos/create")

  return { success: true, project: project as VideoProject }
}

// ─── SUBMIT AVATAR VIDEO RENDER (D-ID + ElevenLabs) ──────────────────────────
// Named submitToHeyGen until the l39 rename. There is no HeyGen path: this
// dispatches through the platform video provider, which resolveVideoProvider
// hard-locks to D-ID. The error strings below said "HeyGen" too — an agent
// whose render failed was told a vendor we do not use had failed them.

export async function submitAvatarVideoRender(
  projectId: string,
  brokerageId: string
): Promise<{ success: boolean; providerVideoId?: string; error?: string; requiresConfiguration?: boolean }> {
  if (!isValidUUID(projectId)) return { success: false, error: "Invalid project ID" }

  const supabase = await createClient()

  const { data: project, error: loadError } = await supabase
    .from("ai_video_projects")
    .select("*")
    .eq("id", projectId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (loadError || !project) {
    return { success: false, error: "Video project not found" }
  }

  if (!project.provider_avatar_id || !project.provider_voice_id) {
    return {
      success: false,
      error: "Avatar and voice must be configured before generating. Set them up in Settings.",
    }
  }

  // Mark as generating
  await supabase
    .from("ai_video_projects")
    .update({ status: "generating", provider_status: "pending", updated_at: new Date().toISOString() })
    .eq("id", projectId)

  // Submit to D-ID (platform-locked engine; canonical provider_* columns)
  const result = await generateAvatarVideo({
    avatarId: project.provider_avatar_id,
    voiceId: project.provider_voice_id,
    script: project.script_content,
    brokerageId,
  })

  if (!result.success) {
    // Mark as failed
    await supabase
      .from("ai_video_projects")
      .update({
        status: "failed",
        provider_status: "failed",
        error_message: result.error ?? "Avatar video submission failed (D-ID)",
        updated_at: new Date().toISOString(),
      })
      .eq("id", projectId)

    return {
      success: false,
      error: result.error,
      requiresConfiguration: (result as any).requiresConfiguration ?? false,
    }
  }

  // Store the D-ID job id
  await supabase
    .from("ai_video_projects")
    .update({
      provider_job_id: result.videoId,
      provider_status: "processing",
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId)

  revalidatePath("/dashboard/videos")

  return { success: true, providerVideoId: result.videoId }
}

// ─── POLL VIDEO STATUS ────────────────────────────────────────────────────────

export async function pollVideoStatus(
  projectId: string,
  brokerageId: string
): Promise<{
  status: "generating" | "ready" | "failed"
  videoUrl?: string
  thumbnailUrl?: string
  error?: string
}> {
  if (!isValidUUID(projectId)) return { status: "failed", error: "Invalid project ID" }

  const supabase = await createClient()

  const { data: project } = await supabase
    .from("ai_video_projects")
    .select("provider_job_id, status, video_url, thumbnail_url, error_message")
    .eq("id", projectId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (!project) return { status: "failed", error: "Project not found" }

  // Already resolved
  if (project.status === "ready" && project.video_url) {
    return { status: "ready", videoUrl: project.video_url, thumbnailUrl: project.thumbnail_url ?? undefined }
  }
  if (project.status === "failed") {
    return { status: "failed", error: project.error_message ?? "Generation failed" }
  }

  if (!project.provider_job_id) {
    return { status: "generating" }
  }

  // Poll the D-ID render
  const providerResult = await getAvatarVideoStatus(project.provider_job_id)

  if (!providerResult.success) {
    return { status: "generating" }
  }

  const providerStatus: string = providerResult.status ?? "processing"

  if (providerStatus === "completed" && providerResult.videoUrl) {
    // Update project to ready
    await supabase
      .from("ai_video_projects")
      .update({
        status: "ready",
        provider_status: "completed",
        video_url: providerResult.videoUrl,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", projectId)

    // Emit kernel event
    await supabase.from("lifecycle_events").insert({
      entity_type: "video_project",
      entity_id: projectId,
      brokerage_id: brokerageId,
      event_type: KernelEvent.VIDEO_PREVIEW_READY,
      metadata: { video_url: providerResult.videoUrl },
    })

    await processKernelEvent({
      event: KernelEvent.VIDEO_PREVIEW_READY,
      brokerageId,
      entityType: "video_project",
      entityId: projectId,
    }).catch(() => {})

    revalidatePath("/dashboard/videos")

    return { status: "ready", videoUrl: providerResult.videoUrl }
  }

  if (providerStatus === "failed") {
    await supabase
      .from("ai_video_projects")
      .update({
        status: "failed",
        provider_status: "failed",
        error_message: "Avatar video generation failed (D-ID)",
        updated_at: new Date().toISOString(),
      })
      .eq("id", projectId)

    return { status: "failed", error: "Avatar video generation failed (D-ID)" }
  }

  // Still processing
  return { status: "generating" }
}

// ─── GET VIDEO PROJECT ────────────────────────────────────────────────────────

export async function getVideoProject(projectId: string, brokerageId: string): Promise<VideoProject | null> {
  if (!isValidUUID(projectId)) return null

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("ai_video_projects")
    .select("*")
    .eq("id", projectId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (error || !data) return null
  return data as VideoProject
}

// ─── GET VIDEO PROJECTS (LIBRARY) ─────────────────────────────────────────────

export async function getVideoProjects(brokerageId: string, agentId?: string): Promise<VideoProject[]> {
  if (!isValidUUID(brokerageId)) return []

  const supabase = await createClient()

  let query = supabase
    .from("ai_video_projects")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(50)

  if (agentId && isValidUUID(agentId)) {
    query = query.eq("agent_id", agentId)
  }

  const { data, error } = await query
  if (error) return []
  return (data ?? []) as VideoProject[]
}

// ─── RETRY VIDEO GENERATION ─���───────────────────────────────────────────────

export async function retryVideoGeneration(
  projectId: string,
  brokerageId: string
): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(projectId)) return { success: false, error: "Invalid project ID" }

  const supabase = await createClient()

  const { data: project } = await supabase
    .from("ai_video_projects")
    .select("retry_count, status")
    .eq("id", projectId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (!project) return { success: false, error: "Project not found" }

  const retryCount = (project.retry_count ?? 0) + 1
  if (retryCount > 3) {
    return { success: false, error: "Maximum retry attempts reached. Please contact support." }
  }

  // Reset status
  await supabase
    .from("ai_video_projects")
    .update({
      status: "draft",
      provider_status: null,
      provider_job_id: null,
      video_url: null,
      error_message: null,
      retry_count: retryCount,
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId)

  // Resubmit
  const submitResult = await submitAvatarVideoRender(projectId, brokerageId)

  if (!submitResult.success) {
    return { success: false, error: submitResult.error }
  }

  return { success: true }
}

// getUserAvatarConfig was REMOVED. It had zero callers while sitting in a
// "use server" module, so it was a live RPC endpoint nobody used — and it was
// wrong twice over: it looked up ai_identity_profiles.scope_id and
// agent_voice_profiles.agent_id (both agents.id) with the AUTH USER id, so it
// could only ever report isConfigured:false. lib/video/video-identity.ts is the
// canonical resolver — right id class, and the full agent → team → brokerage
// cascade with honest fallbacks.

// ─── GET SOCIAL ACCOUNTS ─────────────────────────────────────────────────────

export async function getSocialAccountsForDistribution(brokerageId: string, agentId: string) {
  if (!isValidUUID(brokerageId)) return []

  const supabase = await createClient()

  const { data } = await supabase
    .from("social_media_accounts")
    .select("id, platform, account_name, is_active")
    .eq("brokerage_id", brokerageId)
    .eq("agent_id", agentId)
    .eq("is_active", true)
    .order("platform")

  return data ?? []
}
