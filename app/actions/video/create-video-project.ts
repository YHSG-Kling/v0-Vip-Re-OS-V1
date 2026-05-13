"use server"

import { createClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { generateHeyGenVideo, getHeyGenVideoStatus } from "@/app/actions/external-services"

// ============================================
// VIDEO PROJECT CREATION — ai_video_projects
// Full lifecycle: script → generate → distribute
// ============================================

export interface CreateVideoProjectParams {
  brokerageId: string
  agentId: string
  title: string
  script: string
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
}

export interface VideoProject {
  id: string
  title: string
  script_content: string
  video_type: string
  status: "draft" | "generating" | "ready" | "failed" | "distributed"
  heygen_video_id: string | null
  heygen_status: string | null
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
  if (!isValidUUID(params.brokerageId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid brokerage or agent ID" }
  }
  if (!params.title?.trim()) {
    return { success: false, error: "Title is required" }
  }
  if (!params.script?.trim()) {
    return { success: false, error: "Script is required" }
  }

  const supabase = await createClient()

  // Migration 1052: provider resolved (D-ID default; agent + brokerage
  // overrides). Hard-coded 'heygen' before — wrong; @d-id/client-sdk is
  // the primary in package.json and agent_voice_profiles defaults to 'did'.
  const { resolveVideoProvider, initialProviderColumns } = await import("@/lib/marketing/video-provider-resolver")
  const provider = await resolveVideoProvider(supabase, {
    brokerageId: params.brokerageId,
    agentUserId: params.agentId,
  })
  const providerCols = initialProviderColumns(provider)

  const { data: project, error } = await supabase
    .from("ai_video_projects")
    .insert({
      brokerage_id: params.brokerageId,
      agent_id: params.agentId,
      title: params.title,
      script_content: params.script,
      video_type: params.videoType,
      heygen_avatar_id: params.avatarId ?? null,
      heygen_voice_id: params.voiceId ?? null,
      background_type: params.backgroundType,
      background_url: params.backgroundUrl ?? null,
      video_metadata: params.backgroundColorHex
        ? { background_color: params.backgroundColorHex }
        : null,
      format: params.format,
      duration_seconds: params.durationSeconds,
      captions_enabled: params.captionsEnabled,
      listing_id: params.listingId ?? null,
      status: "draft",
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

  // Emit kernel event
  await supabase.from("lifecycle_events").insert({
    entity_type: "video_project",
    entity_id: project.id,
    brokerage_id: params.brokerageId,
    event_type: KernelEvent.VIDEO_GENERATION_REQUESTED,
    actor_user_id: params.agentId,
    metadata: { video_type: params.videoType, title: params.title },
  })

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

// ─── SUBMIT TO HEYGEN ────────────────────────────────────────────────────────

export async function submitToHeyGen(
  projectId: string,
  brokerageId: string
): Promise<{ success: boolean; heygenVideoId?: string; error?: string; requiresConfiguration?: boolean }> {
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

  if (!project.heygen_avatar_id || !project.heygen_voice_id) {
    return {
      success: false,
      error: "Avatar and voice must be configured before generating. Set them up in Settings.",
    }
  }

  // Mark as generating
  await supabase
    .from("ai_video_projects")
    .update({ status: "generating", heygen_status: "pending", updated_at: new Date().toISOString() })
    .eq("id", projectId)

  // Submit to HeyGen
  const result = await generateHeyGenVideo({
    avatarId: project.heygen_avatar_id,
    voiceId: project.heygen_voice_id,
    script: project.script_content,
  })

  if (!result.success) {
    // Mark as failed
    await supabase
      .from("ai_video_projects")
      .update({
        status: "failed",
        heygen_status: "failed",
        error_message: result.error ?? "HeyGen submission failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", projectId)

    return {
      success: false,
      error: result.error,
      requiresConfiguration: (result as any).requiresConfiguration ?? false,
    }
  }

  // Store HeyGen job ID
  await supabase
    .from("ai_video_projects")
    .update({
      heygen_video_id: result.videoId,
      heygen_status: "processing",
      provider_job_id: result.videoId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId)

  revalidatePath("/dashboard/videos")

  return { success: true, heygenVideoId: result.videoId }
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
    .select("heygen_video_id, status, video_url, thumbnail_url, error_message")
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

  if (!project.heygen_video_id) {
    return { status: "generating" }
  }

  // Poll HeyGen
  const heygenResult = await getHeyGenVideoStatus(project.heygen_video_id)

  if (!heygenResult.success) {
    return { status: "generating" }
  }

  const heygenStatus: string = heygenResult.status ?? "processing"

  if (heygenStatus === "completed" && heygenResult.videoUrl) {
    // Update project to ready
    await supabase
      .from("ai_video_projects")
      .update({
        status: "ready",
        heygen_status: "completed",
        video_url: heygenResult.videoUrl,
        provider_status: "completed",
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
      metadata: { video_url: heygenResult.videoUrl },
    })

    await processKernelEvent({
      event: KernelEvent.VIDEO_PREVIEW_READY,
      brokerageId,
      entityType: "video_project",
      entityId: projectId,
    }).catch(() => {})

    revalidatePath("/dashboard/videos")

    return { status: "ready", videoUrl: heygenResult.videoUrl }
  }

  if (heygenStatus === "failed") {
    await supabase
      .from("ai_video_projects")
      .update({
        status: "failed",
        heygen_status: "failed",
        error_message: "HeyGen video generation failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", projectId)

    return { status: "failed", error: "Video generation failed in HeyGen" }
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
      heygen_status: null,
      heygen_video_id: null,
      video_url: null,
      error_message: null,
      retry_count: retryCount,
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId)

  // Resubmit
  const submitResult = await submitToHeyGen(projectId, brokerageId)

  if (!submitResult.success) {
    return { success: false, error: submitResult.error }
  }

  return { success: true }
}

// ─── GET USER AVATAR CONFIG ─────────────────────────────────────────────────

export async function getUserAvatarConfig(userId: string, brokerageId: string) {
  if (!isValidUUID(userId)) return null

  const supabase = await createClient()

  // Check ai_identity_profiles for avatar + voice config
  const { data: profile } = await supabase
    .from("ai_identity_profiles")
    .select("id, avatar_url, scope_id, scope_type, persona_label, assistant_name")
    .eq("brokerage_id", brokerageId)
    .eq("scope_id", userId)
    .eq("scope_type", "agent")
    .eq("active", true)
    .maybeSingle()

  // Check video_branding_presets for heygen avatar + voice
  const { data: preset } = await supabase
    .from("video_branding_presets")
    .select("id, heygen_avatar_id, heygen_voice_id, logo_url, primary_color, preset_name")
    .eq("agent_id", userId)
    .eq("is_default", true)
    .maybeSingle()

  return {
    avatarUrl: profile?.avatar_url ?? null,
    heygenAvatarId: preset?.heygen_avatar_id ?? null,
    heygenVoiceId: preset?.heygen_voice_id ?? null,
    brandingPresetId: preset?.id ?? null,
    primaryColor: preset?.primary_color ?? null,
    logoUrl: preset?.logo_url ?? null,
    isConfigured: !!(preset?.heygen_avatar_id && preset?.heygen_voice_id),
  }
}

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
