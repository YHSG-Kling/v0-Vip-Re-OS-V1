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

// ─── THE TENANT GATE ─────────────────────────────────────────────────────────
//
// Every export in this file is a "use server" function, i.e. an HTTP endpoint
// the browser can call by name with arguments of its choosing. Several of them
// took `brokerageId` as an ARGUMENT and filtered on it — which authenticates
// nothing: a caller who names another tenant's brokerage_id alongside that
// tenant's projectId matches the row and is served it.
//
// RLS does not save this table. ai_video_projects.brokerage_id is NULLABLE and
// every policy on it reads
//   (brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())
// so an untenanted row is readable by EVERY brokerage. The gate below compares
// the project's brokerage_id to the CALLER'S SESSION brokerage for equality,
// which a NULL can never satisfy, and it ignores whatever brokerageId the
// caller passed. The argument is kept on the signatures so existing callers
// keep compiling; it is deliberately never trusted.
//
// Same shape as app/actions/video.ts:assertProjectInCallerBrokerage — this file
// cannot import that module (it is the video-kernel door, a different rail), so
// the gate is restated rather than shared.

async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) return { ok: false, error: "Unauthorized" }
  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", auth.user.id)
    .maybeSingle()
  if (profileError) return { ok: false, error: profileError.message }
  if (!profile?.brokerage_id) {
    return { ok: false, error: "Your account is not linked to a brokerage yet" }
  }
  return { ok: true, userId: auth.user.id, brokerageId: profile.brokerage_id as string }
}

/**
 * Resolve a projectId to the caller's OWN brokerage, or refuse.
 * Returns the caller identity plus the verified tenant on success.
 *
 * Reads through the service client on purpose: the point is to observe the
 * row's real brokerage_id (including NULL) rather than whatever RLS is willing
 * to show, and then compare it for equality.
 */
async function requireProjectInCallerBrokerage(projectId: string): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  if (!isValidUUID(projectId)) return { ok: false, error: "Invalid project ID" }
  const caller = await requireCaller()
  if (!caller.ok) return caller
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { data: project, error } = await svc
    .from("ai_video_projects")
    .select("brokerage_id")
    .eq("id", projectId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  // Not-found and wrong-tenant answer identically so this cannot be used to
  // enumerate project ids across tenants.
  if (!project || project.brokerage_id !== caller.brokerageId) {
    return { ok: false, error: "Video project not found" }
  }
  return { ok: true, userId: caller.userId, brokerageId: caller.brokerageId }
}

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
  /** ignored — derived from the session. Kept so existing callers compile. */
  brokerageId?: string
  /** ignored — derived from the session. USERS-class, never agents.id. */
  agentId?: string
  listingAddress?: string
  listingPrice?: number
  listingFeatures?: string[]
}) {
  // Burns paid AI inference and reads brand-voice/compliance config for a
  // brokerage, so it authenticates before it spends. The caller-supplied
  // brokerageId/agentId are ignored — they authenticated nothing.
  const auth = await requireCaller()
  if (!auth.ok) return { error: auth.error, script: "", wordCount: 0, complianceAllowed: false, complianceViolations: [auth.error] }
  const brokerageId = auth.brokerageId
  // USERS-class throughout: generateText's agentId, applyBrandVoice's
  // actorUserId and evaluateOutbound's actorContext.userId are all users ids.
  // Substituting an agents.id here would be a cross-class bug.
  const actorUserId = auth.userId

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
    agentId: actorUserId,
    brokerageId,
  })

  // Apply brand voice
  const withVoice = await applyBrandVoice({
    content: raw.text,
    brokerageId,
    actorUserId,
    actorRole: "agent",
    journeyType: "seller",
    persona: "seller",
    messageType: "social",
  }).then((r) => r.content, () => raw.text)

  // Compliance check
  const scriptContent = typeof withVoice === "string" ? withVoice : raw.text
  const compliance = await evaluateOutbound({
    actorContext: {
      userId: actorUserId,
      role: "agent",
      brokerageId,
    },
    journeyType: "buyer",
    persona: "first_time",
    messageType: "social",
    content: scriptContent,
    // Broadcast payload — see lib/video/script-compliance.ts for why the
    // stub contact is omitted rather than faked.
  }).catch(() => ({ allowed: true, violations: [] as string[] }))

  return {
    script: scriptContent,
    wordCount: scriptContent.split(/\s+/).filter(Boolean).length,
    complianceAllowed: compliance.allowed,
    complianceViolations: compliance.allowed ? [] : (compliance.violations ?? []),
  }
}

// ─── IMPROVE EXISTING SCRIPT ────────────────────────────────────────────────

export type ScriptImprovement = "flow" | "shorter" | "more_engaging" | "luxury" | "friendly"

export interface ImproveScriptResult {
  success: boolean
  script?: string
  wordCount?: number
  error?: string
}

export async function improveScript(params: {
  currentScript: string
  improvement: ScriptImprovement
  /** ignored — derived from the session. */
  brokerageId?: string
  /** ignored — derived from the session. USERS-class. */
  agentId?: string
}): Promise<ImproveScriptResult> {
  // Paid inference behind a browser-callable endpoint: authenticate first, and
  // derive the tenant from the session rather than the argument.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!params.currentScript?.trim()) {
    return { success: false, error: "There is no script to improve yet." }
  }

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

  let result: { text: string }
  try {
    result = await generateText({
      prompt,
      feature: "video_script_generation",
      // USERS-class id — same class generateAIScript feeds it.
      agentId: auth.userId,
      brokerageId: auth.brokerageId,
    })
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Script rewrite failed",
    }
  }

  const text = result?.text?.trim() ?? ""
  if (!text) {
    return { success: false, error: "The model returned an empty script — nothing was changed." }
  }

  return {
    success: true,
    script: text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
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

/**
 * ⚠ DELIBERATELY NOT WIRED TO ANY SURFACE — third-render-writer hazard.
 *
 * Two paths already start a render against the SAME ai_video_projects row and
 * the owner has ruled they are NOT to be consolidated:
 *
 *   1. POST /api/did/generate-video  — writes status='generating',
 *      provider_job_id=<D-ID talk id>, provider_metadata.provider='did'
 *      (app/api/did/generate-video/route.ts:326). It is the path that also runs
 *      checkBrandCompliance and injects the required verbal disclosure before
 *      submitting (same file, ~line 191 refuses with status='failed' when the
 *      compliance gate fails).
 *   2. lib/kernel/video.ts:submitVideoGenerationJob via
 *      app/actions/video.ts:submitVideoGenerationJobAction — writes
 *      status='generating', provider_status='submitting' behind an ATOMIC slot
 *      claim (.neq("status","generating").neq("status","submitting"),
 *      lib/kernel/video.ts:334-340) so two clicks cannot both submit.
 *
 * This function would be the THIRD. It writes the identical
 * (status='generating' + provider_job_id) shape via generateAvatarVideo →
 * lib/did:generateVideo, which is the same D-ID talk id space — so
 * app/api/cron/poll-did-videos (selector: status='generating' AND
 * provider_job_id IS NOT NULL) would immediately adopt rows this created and
 * finalize them, while this path has:
 *   · NO compliance/disclosure gate (unlike path 1), and
 *   · NO atomic slot claim (unlike path 2) — it stamps 'generating'
 *     unconditionally, so it can stomp a render already in flight.
 * Only ONE thing may claim a project's render slot, and two things already do.
 *
 * It is NOT deleted: it is the only render entry that returns
 * `requiresConfiguration`, and per the governing rule there is no named
 * duplicate that does its job MORE completely without losing that. It is
 * hardened here (real tenant gate, errors destructured) so that its existing
 * exposure as a browser-callable endpoint is safe, and left unreferenced.
 */
export async function submitAvatarVideoRender(
  projectId: string,
  _brokerageId?: string  // ignored — derived from the session
): Promise<{ success: boolean; providerVideoId?: string; error?: string; requiresConfiguration?: boolean }> {
  const gate = await requireProjectInCallerBrokerage(projectId)
  if (!gate.ok) return { success: false, error: gate.error }
  const brokerageId = gate.brokerageId

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

  // Mark as generating. supabase-js RESOLVES a refused update instead of
  // throwing, so an un-destructured await here reported a claim that never
  // landed and then spent money anyway.
  const { error: claimError } = await supabase
    .from("ai_video_projects")
    .update({ status: "generating", provider_status: "pending", updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("brokerage_id", brokerageId)
  if (claimError) {
    console.error("[create-video-project] Could not claim render slot:", claimError)
    return { success: false, error: claimError.message }
  }

  // Submit to D-ID (platform-locked engine; canonical provider_* columns)
  const result = await generateAvatarVideo({
    avatarId: project.provider_avatar_id,
    voiceId: project.provider_voice_id,
    script: project.script_content,
    brokerageId,
  })

  if (!result.success) {
    // Mark as failed
    const { error: failError } = await supabase
      .from("ai_video_projects")
      .update({
        status: "failed",
        provider_status: "failed",
        error_message: result.error ?? "Avatar video submission failed (D-ID)",
        updated_at: new Date().toISOString(),
      })
      .eq("id", projectId)
      .eq("brokerage_id", brokerageId)
    if (failError) {
      console.error("[create-video-project] Could not record render failure:", failError)
    }

    return {
      success: false,
      error: result.error,
      requiresConfiguration: (result as any).requiresConfiguration ?? false,
    }
  }

  // Store the D-ID job id
  const { error: jobIdError } = await supabase
    .from("ai_video_projects")
    .update({
      provider_job_id: result.videoId,
      provider_status: "processing",
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId)
    .eq("brokerage_id", brokerageId)
  if (jobIdError) {
    // The vendor render is already running; if we cannot persist its id nobody
    // can ever finish this row, so say so rather than reporting success.
    console.error("[create-video-project] Could not persist provider job id:", jobIdError)
    return { success: false, error: `Render submitted but its job id could not be saved: ${jobIdError.message}` }
  }

  revalidatePath("/dashboard/videos")

  return { success: true, providerVideoId: result.videoId }
}

// ─── POLL VIDEO STATUS ────────────────────────────────────────────────────────

/**
 * ⚠ DELIBERATELY NOT WIRED TO ANY SURFACE — competing terminal writer.
 *
 * app/api/cron/poll-did-videos is the canonical async finalizer for exactly the
 * rows this would poll. Its selector is `status='generating' AND
 * provider_job_id IS NOT NULL` and on completion it writes status='completed'
 * (route.ts:391); on vendor error, status='failed' (route.ts:541).
 *
 * ai_video_projects.status has NO CHECK constraint, so "valid" is settled by
 * the writers, and there are two vocabularies live on this table. This function
 * writes the OTHER one: status='ready'. Wiring it would mean:
 *   · a third writer racing the cron for the same row's terminal state, and
 *   · a terminal token no reader on the repurpose rail understands — the
 *     Omni-Presence source picker selects .eq("status","completed")
 *     (app/dashboard/campaigns/repurpose/page.tsx) and
 *     app/actions/podcast-generation.ts:getVideoProjects selects
 *     .in("status",["completed","published"]). A project finalized as 'ready'
 *     would be invisible to every repurposing surface AND would no longer match
 *     the cron's 'generating' selector, so nothing would ever correct it.
 *
 * Not deleted (no named duplicate is reachable as a server action for a
 * synchronous "is it done yet" read), hardened, and left unreferenced.
 */
export async function pollVideoStatus(
  projectId: string,
  _brokerageId?: string  // ignored — derived from the session
): Promise<{
  status: "generating" | "ready" | "failed"
  videoUrl?: string
  thumbnailUrl?: string
  error?: string
}> {
  const gate = await requireProjectInCallerBrokerage(projectId)
  if (!gate.ok) return { status: "failed", error: gate.error }
  const brokerageId = gate.brokerageId

  const supabase = await createClient()

  const { data: project, error: loadError } = await supabase
    .from("ai_video_projects")
    .select("provider_job_id, status, video_url, thumbnail_url, error_message")
    .eq("id", projectId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (loadError) return { status: "failed", error: loadError.message }
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
    const { error: readyError } = await supabase
      .from("ai_video_projects")
      .update({
        status: "ready",
        provider_status: "completed",
        video_url: providerResult.videoUrl,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", projectId)
      .eq("brokerage_id", brokerageId)
    if (readyError) {
      console.error("[create-video-project] Could not persist ready status:", readyError)
      return { status: "generating", error: readyError.message }
    }

    // Emit kernel event
    const { error: eventError } = await supabase.from("lifecycle_events").insert({
      entity_type: "video_project",
      entity_id: projectId,
      brokerage_id: brokerageId,
      event_type: KernelEvent.VIDEO_PREVIEW_READY,
      metadata: { video_url: providerResult.videoUrl },
    })
    if (eventError) {
      console.error("[create-video-project] lifecycle_events insert error:", eventError)
    }

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
    const { error: failError } = await supabase
      .from("ai_video_projects")
      .update({
        status: "failed",
        provider_status: "failed",
        error_message: "Avatar video generation failed (D-ID)",
        updated_at: new Date().toISOString(),
      })
      .eq("id", projectId)
      .eq("brokerage_id", brokerageId)
    if (failError) {
      console.error("[create-video-project] Could not persist failed status:", failError)
    }

    return { status: "failed", error: "Avatar video generation failed (D-ID)" }
  }

  // Still processing
  return { status: "generating" }
}

// ─── GET VIDEO PROJECT ────────────────────────────────────────────────────────

/**
 * One video project, gated to the caller's own brokerage.
 * WIRED: the Snippet Wizard (Omni-Presence Repurposer → Snippet Wizard tab)
 * loads the selected source project here so the agent can see its render state
 * and whether it carries a script BEFORE spending AI inference on suggestions.
 */
export async function getVideoProject(
  projectId: string,
  _brokerageId?: string  // ignored — derived from the session
): Promise<VideoProject | null> {
  const gate = await requireProjectInCallerBrokerage(projectId)
  if (!gate.ok) return null

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("ai_video_projects")
    .select("*")
    .eq("id", projectId)
    .eq("brokerage_id", gate.brokerageId)
    .maybeSingle()

  if (error) {
    console.error("[create-video-project] getVideoProject read error:", error)
    return null
  }
  if (!data) return null
  return data as VideoProject
}

/**
 * The shape the Snippet Wizard actually needs — a summary the UI can render
 * without leaking the whole row (script_content included) to the browser.
 * `hasScript` is the load-bearing bit: generateSnippetSuggestions reads
 * ai_video_projects.script_content and silently falls back to a generic clip
 * when it is empty, so the agent is told first.
 */
export interface VideoProjectSnippetSource {
  id: string
  title: string
  status: string
  durationSeconds: number | null
  hasScript: boolean
  videoUrl: string | null
}

export async function getVideoProjectSnippetSource(
  projectId: string
): Promise<{ success: boolean; source?: VideoProjectSnippetSource; error?: string }> {
  const gate = await requireProjectInCallerBrokerage(projectId)
  if (!gate.ok) return { success: false, error: gate.error }

  const project = await getVideoProject(projectId)
  if (!project) return { success: false, error: "Video project not found" }

  return {
    success: true,
    source: {
      id: project.id,
      title: project.title ?? "Untitled project",
      status: project.status ?? "unknown",
      durationSeconds: (project as unknown as { duration_seconds: number | null }).duration_seconds ?? null,
      hasScript: !!project.script_content?.trim(),
      videoUrl: project.video_url ?? null,
    },
  }
}

// ─── GET VIDEO PROJECTS (LIBRARY) ─────────────────────────────────────────────

export async function getVideoProjects(
  _brokerageId?: string,  // ignored — derived from the session
  agentId?: string        // AGENTS-class (ai_video_projects.agent_id FK agents(id))
): Promise<VideoProject[]> {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = await createClient()

  let query = supabase
    .from("ai_video_projects")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })
    .limit(50)

  if (agentId && isValidUUID(agentId)) {
    query = query.eq("agent_id", agentId)
  }

  const { data, error } = await query
  if (error) {
    console.error("[create-video-project] getVideoProjects read error:", error)
    return []
  }
  return (data ?? []) as VideoProject[]
}

// ─── RETRY VIDEO GENERATION ─���───────────────────────────────────────────────

/**
 * ⚠ DELIBERATELY NOT WIRED TO ANY SURFACE — inherits the third-writer hazard.
 *
 * Its last statement is `submitAvatarVideoRender(projectId, ...)`, so it drives
 * the SAME render path documented on that function above, with the compliance
 * gate and the atomic slot claim both absent. It additionally NULLs
 * provider_job_id first, which severs the row from
 * app/api/cron/poll-did-videos — an in-flight D-ID render would be orphaned
 * with nothing left to finalize it.
 *
 * The surface that would host a "Retry" button — the video board — already has
 * its own start control on the kernel path, so wiring this would put a second
 * start button on a surface that already has one.
 *
 * Not deleted: nothing else implements the retry_count ceiling. Hardened and
 * left unreferenced.
 */
export async function retryVideoGeneration(
  projectId: string,
  _brokerageId?: string  // ignored — derived from the session
): Promise<{ success: boolean; error?: string }> {
  const gate = await requireProjectInCallerBrokerage(projectId)
  if (!gate.ok) return { success: false, error: gate.error }
  const brokerageId = gate.brokerageId

  const supabase = await createClient()

  const { data: project, error: loadError } = await supabase
    .from("ai_video_projects")
    .select("retry_count, status")
    .eq("id", projectId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (loadError) return { success: false, error: loadError.message }
  if (!project) return { success: false, error: "Project not found" }

  const retryCount = (project.retry_count ?? 0) + 1
  if (retryCount > 3) {
    return { success: false, error: "Maximum retry attempts reached. Please contact support." }
  }

  // Reset status
  const { error: resetError } = await supabase
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
    .eq("brokerage_id", brokerageId)
  if (resetError) {
    console.error("[create-video-project] Could not reset project for retry:", resetError)
    return { success: false, error: resetError.message }
  }

  // Resubmit
  const submitResult = await submitAvatarVideoRender(projectId)

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

/**
 * The connected social accounts the caller may distribute to.
 * WIRED: the snippet Schedule sheet (/dashboard/videos/snippets) uses this to
 * let the agent choose WHICH connected account a snippet publishes to —
 * scheduleSnippetToSocial already accepts and tenant-checks socialAccountId,
 * but nothing on the surface had ever supplied one.
 *
 * IDENTITY CLASS. social_media_accounts.agent_id is a FK to agents(id)
 * (pg_constraint: social_media_accounts_agent_id_fkey). Every browser caller
 * holds a USERS id, and the old `.eq("agent_id", agentId)` compared the two
 * classes directly — a users id can never equal an agents id, so this returned
 * an empty list for every real caller. The users→agents resolve now happens
 * HERE, through the identity helper, exactly once.
 *
 * Scope: agent-owned accounts PLUS the brokerage-wide ones (agent_id IS NULL,
 * scope='brokerage'). The old filter hid every brokerage account even though
 * scheduleSnippetToSocial's own gate admits them — the picker must not be
 * narrower than what the write accepts.
 *
 * This does NOT publish. It lists destinations; the actual send stays on the
 * existing consent-gated egress (social_posts → publisher cron).
 */
export async function getSocialAccountsForDistribution(
  _brokerageId?: string,  // ignored — derived from the session
  _agentId?: string       // ignored — resolved from the session, users→agents
): Promise<Array<{ id: string; platform: string; account_name: string; is_active: boolean; scope: string | null }>> {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = await createClient()

  const { resolveAgentIdInBrokerage } = await import("@/lib/kernel/agent-identity")
  const resolvedAgentId = await resolveAgentIdInBrokerage(supabase, auth.userId, auth.brokerageId)

  let query = supabase
    .from("social_media_accounts")
    .select("id, platform, account_name, is_active, scope")
    .eq("brokerage_id", auth.brokerageId)
    .eq("is_active", true)
    .order("platform")

  // A user with no agent profile still sees the brokerage-wide accounts.
  query = resolvedAgentId
    ? query.or(`agent_id.eq.${resolvedAgentId},agent_id.is.null`)
    : query.is("agent_id", null)

  const { data, error } = await query
  if (error) {
    console.error("[create-video-project] getSocialAccountsForDistribution read error:", error)
    return []
  }

  return (data ?? []) as Array<{ id: string; platform: string; account_name: string; is_active: boolean; scope: string | null }>
}
