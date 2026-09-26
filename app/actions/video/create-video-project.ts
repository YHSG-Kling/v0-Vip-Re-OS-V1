"use server"

import { createClient } from "@/lib/supabase/server"
import { requireCaller } from "@/lib/auth/require-caller"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
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

// TOMBSTONE: local requireCaller merged onto lib/auth/require-caller.ts:159
// requireCaller (imported above) — §1/§6 SAME BODY census round 3, 2026-09-09.

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
   * MERGED FROM app/actions/listing-media.ts:createVideoProject (wave 56, orphan
   * doctrine §1.1 — the listing media panel's own creator, deleted with a
   * tombstone there). That path carried three things this one lacked:
   *   · templateId → ai_video_projects.provider_template_id (a video_templates row
   *     the agent picked in the listing media panel; lib/kernel/marketing.ts:1049
   *     writes the same column for campaign videos — one column, one meaning).
   *   · audienceType → ai_video_projects.audience_type. Listing videos are
   *     customer-facing by default and must pass compliance at distribute time.
   *   · brandComplianceCheck → after the row lands, lib/kernel/brand-compliance.ts
   *     checkBrandCompliance queues the BRAND check (distinct from the fair-housing
   *     render hold above, which runs BEFORE the row exists).
   */
  templateId?: string
  /** ai_video_projects_audience_type_check is in_house | customer_facing. "internal" is the
   *  old spelling of in_house, folded by the creator (§6); absent → customer_facing. */
  audienceType?: "customer_facing" | "in_house" | "internal"
  brandComplianceCheck?: boolean
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

  // THE SHARED SPOKEN-SCRIPT STANDARDS (lane 76D): the rewrite is a new
  // spoken script, so it carries the SCRIPT_QUALITY_CHARTER + SPOKEN_REALISM_
  // DIRECTIVE through the ONE composer — "make it more engaging" / "elevate
  // the language" are exactly the asks that invite a salesy, stiff, or
  // AI-sounding rewrite, and scanForAiTells (below) was grading for tells the
  // prompt never told the model to avoid.
  const { withSpokenScriptStandards } = await import("@/lib/video/realism-profile")
  const prompt = withSpokenScriptStandards(`${complianceBlocks.join("\n\n")}

${improvementPrompts[params.improvement]}

Original script:
${params.currentScript}

Return only the improved script text, no explanations.`)

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

  // REALISM (lane 74D) — this rewrite is a genuine second model call
  // (app/actions/video/generate-script.ts's own scanForAiTells ran on the
  // ORIGINAL draft, never on what this function's model produces) and its
  // "more_engaging"/"luxury" prompts are exactly the kind of instruction that
  // invites a manufactured-sounding phrase. Same advisory posture as
  // generate-script.ts: never a hold, folded into the same warnings array the
  // agent already sees.
  const { scanForAiTells } = await import("@/lib/video/realism-profile")
  const aiTellHits = scanForAiTells(text)
  const advisoryWarnings = [...(complianceWarnings ?? []), ...aiTellHits]

  return {
    success: true,
    script: text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    // Warnings PASS THROUGH (§5: warnings pass, only a hard flag escalates).
    ...(advisoryWarnings.length > 0 ? { complianceWarnings: advisoryWarnings } : {}),
  }
}

// ─── CREATE VIDEO PROJECT ────────────────────────────────────────────────────

export async function createVideoProject(params: CreateVideoProjectParams): Promise<{
  success: boolean
  project?: VideoProject
  error?: string
  /** True when compliance HELD the video (red_flag or unknown; advisory passes, §5). */
  complianceHold?: boolean
  /** video_scripts_library.id a human now owns, when a hold was raised. */
  complianceReviewId?: string
  /** Everything the agent needs to be told about the hold. */
  complianceReasons?: string[]
  /** ADVISORY (never blocking, §5) — scanForAiTells findings on the final script. */
  realismWarnings?: string[]
}> {
  // TOMBSTONE (wave 85F, §1.1). The fair-housing render HOLD, the realism scan, the in-tenant
  // campaign / script checks, the provider resolve, the users→agents cross, the
  // ai_video_projects insert, the lifecycle event and the brand check MOVED to the one creator,
  // lib/kernel/content-creators.ts createVideoProject (survivor of lib/kernel/marketing.ts
  // createVideoProject too). The voice webhook's cookie client is anon, so its insert was
  // refused by RLS. Closed in the move:
  //   · audience_type was written NULL into a NOT NULL column (23502) for every caller but the
  //     listing media panel, and this type spelled the internal kind "internal" where the CHECK
  //     says in_house (§6). The creator folds it and defaults to customer_facing.
  //   · THIS WAS A "use server" EXPORT THAT TRUSTED `brokerageId` FROM THE BODY (§4), guarded
  //     only by the cookie client's RLS. It now has a SESSION gate: the tenant is the caller's,
  //     a foreign `brokerageId` is refused, and `agentUserId` must be a user with an agents row
  //     in the caller's tenant (the creator's resolve refuses anyone else).
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.error }
  if (params.brokerageId && params.brokerageId !== caller.brokerageId) {
    return { success: false, error: "That brokerage is not yours — a video project is filed in your own brokerage." }
  }
  const { brokerageId: _ignoredTenant, agentUserId, ...fields } = params
  const { createVideoProject: fileVideoProject } = await import("@/lib/kernel/content-creators")
  const result = await fileVideoProject({
    ctx: { userId: agentUserId || caller.userId, brokerageId: caller.brokerageId },
    ...fields,
  })
  if (result.success) {
    revalidatePath("/dashboard/videos")
    revalidatePath("/dashboard/videos/create")
  }
  return { ...result, project: result.project as VideoProject | undefined }
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
