"use server"

import { createClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import type { CanonicalVideoStatus } from "@/lib/video/video-status"
import {
  buildComplianceSystemBlocks,
  postcheckScript,
  detectProhibitedPhraseRedFlags,
} from "@/lib/video/script-compliance"

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
  /**
   * SCRIPT PROVENANCE — the `public.scripts` row this video is being rendered
   * from, when the agent picked a saved script instead of pasting raw text.
   *
   * m429 added ai_video_projects.source_script_id for this, and it is the link
   * the owner's viral rule stands on: "if the video goes viral using that
   * script, it should be shared to the whole brokerage."
   * lib/video/viral-script-share.ts resolves the video → this script → its
   * brokerage, and flips the script to brokerage-shared once the project passes
   * VIRAL_VIEW_THRESHOLD views.
   *
   * Tenant-checked here for the reason the campaignId block below already
   * records: the foreign key proves the script exists, never that it is ours.
   * Note this is `public.scripts`, NOT `video_scripts_library` — two different
   * tables. generateVideoFromScript's own `scriptId` names the latter.
   */
  sourceScriptId?: string
}

export interface VideoProject {
  id: string
  title: string
  script_content: string
  video_type: string
  // The m374 CHECK constraint refuses anything outside CANONICAL_VIDEO_STATUSES,
  // so lib/video/video-status.ts — not a union kept here — is the one place the
  // vocabulary is written down.
  status: CanonicalVideoStatus
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

// ─── AI SCRIPT GENERATION — DELETED (orphan doctrine §1.1, 2026-09-03) ───────
//
// TOMBSTONE — `generateAIScript(params)` is DELETED. Survivor:
// app/actions/video/generate-script.ts `generateVideoScript`, wired to the
// wizard (app/dashboard/videos/create/video-create-client.tsx). The merge ran
// in the doctrine's direction BEFORE this deletion: the survivor's header
// records that the session-derived tenant gate was ported FROM this function
// onto it; everything else this function did (compliance blocks in the prompt,
// brief pre-check, advisory post-check, red-flag escalation, fail-closed hold
// on an unevaluated script, tri-state complianceState) the survivor already
// did, plus saveToLibrary and nine video types against five. Vocabulary:
// this function's `listing_tour` is the survivor's `property_tour` (§6).


// ─── IMPROVE EXISTING SCRIPT ────────────────────────────────────────────────

export type ScriptImprovement = "flow" | "shorter" | "more_engaging" | "luxury" | "friendly"

export interface ImproveScriptResult {
  success: boolean
  script?: string
  wordCount?: number
  error?: string
  /** Post-check findings that are ADVISORY — shown, never blocking (§5). */
  complianceWarnings?: string[]
  /** True when the rewrite tripped a hard flag and was NOT returned. */
  complianceBlocked?: boolean
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

  // COMPLIANCE-FIRST, ON THE REWRITE TOO (CLAUDE.md §5; integrator, wave 26).
  // A script that passed the gate is handed to a model here and rewritten —
  // "make it more engaging", "elevate the language" — and until now the rewrite
  // was returned to the agent with no compliance blocks in its prompt and no
  // post-check on its output. The gate the survivor runs was applied to text the
  // model then replaced, so this was the last script path outside it.
  //
  // Same shape as generate-script.ts: STEER first (the blocks are inputs, not a
  // verdict), then grade what came back. The tenant is the session's.
  const actor = { userId: auth.userId, brokerageId: auth.brokerageId }
  const complianceBlocks = await buildComplianceSystemBlocks(auth.brokerageId)

  const prompt = `${complianceBlocks.join("\n\n")}

${improvementPrompts[params.improvement]}

Original script:
${params.currentScript}

Return only the improved script text, no explanations.`

  let result: { text: string }
  try {
    result = await generateText({
      prompt,
      feature: "video_script_generation",
      // USERS-class id — the same class the script survivor
      // (app/actions/video/generate-script.ts) feeds generateAIResponse.
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

  // POST-CHECK the rewrite. `improvement` carries no buyer/seller context, so the
  // journey is graded as "buyer" — the stricter of the two for fair-housing
  // phrasing, which is the safe direction when the caller has not said.
  const complianceWarnings = await postcheckScript(actor, text, "buyer")
  const redFlags = detectProhibitedPhraseRedFlags(complianceWarnings ?? [])
  if (redFlags.length > 0) {
    // The ORIGINAL script is untouched and still on screen. Refusing here loses
    // nothing the agent had; returning the rewrite would hand them copy the
    // brokerage marked blocking.
    return {
      success: false,
      complianceBlocked: true,
      complianceWarnings: redFlags,
      error: `The rewrite used wording your brokerage blocks: ${redFlags.join("; ")}`,
    }
  }

  return {
    success: true,
    script: text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    // Warnings PASS THROUGH (§5: warnings pass, only a hard flag escalates).
    ...(complianceWarnings && complianceWarnings.length > 0 ? { complianceWarnings } : {}),
  }
}

// ─── CREATE VIDEO PROJECT ────────────────────────────────────────────────────

export async function createVideoProject(params: CreateVideoProjectParams): Promise<{
  success: boolean
  project?: VideoProject
  error?: string
  /** True when compliance HELD the video — see the block below. */
  complianceHold?: boolean
  /** video_scripts_library.id a human now owns, when a hold was raised. */
  complianceReviewId?: string
  /** Everything the agent needs to be told about the hold. */
  complianceReasons?: string[]
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

  // ── THE HOLD ───────────────────────────────────────────────────────────────
  //
  // OWNER RULING (the refinement): "after the script is run then hold up the
  // video creation if still have a big red flag needed for a human."
  //
  // Everything upstream of here GRADED the script and, at most, filed a review
  // row — and then handed the caller a script this function would turn into a
  // video anyway, because it had never read that row. That is escalation
  // without a hold.
  //
  // ADVISORY STILL PASSES, and that is asserted in both directions: the gate
  // holds on `red_flag` and `unknown` ONLY. A ThemFirst pronoun ratio, a
  // "safe area", a brand-voice drift or a UDAAP pricing phrase renders exactly
  // as it did before — the first half of the ruling forbids holding those up.
  //
  // The scriptless shell lane (scriptPending) has nothing to judge yet; its
  // script arrives through POST /api/video/projects/[projectId]/script and the
  // render doors below it are gated, so a shell cannot smuggle a red flag past.
  if (params.script?.trim()) {
    const { evaluateVideoRenderHold } = await import("@/lib/video/video-render-hold")
    const hold = await evaluateVideoRenderHold({
      supabase,
      // Tenant and identity are the CALLER'S — createVideoProject's brokerageId
      // parameter is already the session's at every gated call site, and the
      // review row RLS (`brokerage_id = current_user_brokerage_id()`) refuses
      // anything else, so a foreign id cannot file a hold into another tenant.
      actor: { userId: params.agentUserId, brokerageId: params.brokerageId },
      script: params.script,
      scriptId: undefined,
      videoType: params.videoType,
      title: params.title,
    })
    if (hold.hold) {
      return {
        success: false,
        complianceHold: true,
        complianceReviewId: hold.reviewId,
        complianceReasons: hold.reasons,
        error: hold.reasons[0] ?? "This video is held for human compliance review.",
      }
    }
  }

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

  // SCRIPT PROVENANCE, tenant-checked on exactly the campaign block's reasoning:
  // ai_video_projects.source_script_id is a foreign key, and a foreign key only
  // proves the script EXISTS. Writing a caller-supplied id unverified would let
  // a video attribute itself to another brokerage's script — and since
  // lib/video/viral-script-share.ts follows this column to decide WHICH script a
  // viral video promotes, that would be a cross-tenant write dressed up as an
  // attribution. Resolve it inside the tenant or refuse.
  //
  // The `.eq("brokerage_id", …)` here is deliberate and is NOT the recurring
  // `.eq` -vs- platform-row defect: a platform-catalogue script carries
  // brokerage_id IS NULL and `NULL = <uuid>` is never true, so this lookup
  // cannot match one. That is the wanted behaviour — the platform catalogue is
  // not any tenant's to have promoted on its behalf, and viral-script-share.ts
  // refuses a NULL-tenant script for the same reason.
  let sourceScriptId: string | null = null
  if (params.sourceScriptId) {
    if (!isValidUUID(params.sourceScriptId)) {
      return { success: false, error: "Invalid script ID" }
    }
    const { data: sourceScript, error: sourceScriptError } = await supabase
      .from("scripts")
      .select("id")
      .eq("id", params.sourceScriptId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()
    if (sourceScriptError) {
      console.error("[create-video-project] Source script lookup error:", sourceScriptError)
      return { success: false, error: sourceScriptError.message }
    }
    if (!sourceScript) {
      return { success: false, error: "Script not found in this brokerage" }
    }
    sourceScriptId = sourceScript.id
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
      source_script_id: sourceScriptId,
      format: params.format,
      duration_seconds: params.durationSeconds,
      captions_enabled: params.captionsEnabled,
      listing_id: params.listingId ?? null,
      // TWO LANES, TWO CANONICAL STATES. The kernel used 'setup' for a
      // scriptless shell (POST .../script fills it in later) and 'draft' when a
      // script came with the request. m374 retired 'setup', and collapsing both
      // to 'draft' would have thrown the distinction away — the shell lane is
      // the one thing the survivor had to keep in order to create everything
      // the kernel could.
      //
      // It is kept using canonical values instead: no script yet is 'draft'
      // (created, nothing started), a script already in hand is 'script_ready'
      // (the next step is a render, not authoring). That also gives
      // 'script_ready' its first writer — it was in the vocabulary and in the
      // in-progress set with nothing producing it, which is how the phantom
      // filters this whole merge removed came to exist in the first place.
      status: params.script?.trim() ? "script_ready" : "draft",
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

// ─── SUBMIT AVATAR VIDEO RENDER — DELETED (orphan doctrine §1.1, 2026-09-03) ─
//
// TOMBSTONE — `submitAvatarVideoRender(projectId)` is DELETED. Survivor:
// lib/kernel/video.ts `submitVideoGenerationJob` (via app/actions/video.ts
// `submitVideoGenerationJobAction`, wired from
// app/dashboard/videos/board/video-studio-dialog.tsx), which holds the same
// evaluateVideoRenderHold gate AND the atomic `.neq("status","generating")`
// slot claim this function never had. The survivor signals a missing avatar by
// throwing "avatarId is required…" where this returned `requiresConfiguration`;
// same fact, one spelling. The Fair-Housing hold that guarded this door lives
// on in the survivor (scripts/video-script-compliance-simulator.ts B26).


// ─── POLL VIDEO STATUS — DELETED (orphan doctrine §1.1, 2026-09-03) ─────────
//
// TOMBSTONE — `pollVideoStatus(projectId)` is DELETED. Survivors:
//   · app/api/cron/poll-did-videos/route.ts — the canonical async finalizer for
//     status='generating' AND provider_job_id IS NOT NULL rows (writes the
//     terminal 'completed'/'failed' tokens). This function was a THIRD writer
//     racing it for the same row's terminal state.
//   · `getVideoProject` below (WIRED) — the synchronous "is it done yet" read
//     of status/video_url/thumbnail_url, without a browser-initiated vendor
//     poll. It also carried a raw `lifecycle_events` insert, which the kernel
//     rule (lib/kernel/emit.ts) forbids outside emitKernelEvent; that died here.


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

// ─── RETRY VIDEO GENERATION — DELETED (orphan doctrine §1.1, 2026-09-03) ────
//
// TOMBSTONE — `retryVideoGeneration(projectId)` is DELETED. Survivor:
// app/dashboard/videos/board/page.tsx `handleRetry` (the "Retry Generation"
// control on failed cards), which resets the row and re-submits through
// app/api/did/generate-video — the compliance-gated door. The ONE thing this
// function had that the survivor lacked — the retry_count ceiling of 3 — was
// ported onto the survivor first. What did NOT move, on purpose: this function
// NULLed provider_job_id before resubmitting, which severed an in-flight D-ID
// job from app/api/cron/poll-did-videos; the survivor leaves it alone.


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
