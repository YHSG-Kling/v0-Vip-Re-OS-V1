"use server"

import { createServerClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import {
  generateVideoScript,
  updateVideoGenerationSettings,
  submitVideoGenerationJob,
  loadVideoGenerationState,
  previewVideoProject,
  distributeVideoProject,
  repurposeVideoOutput,
  loadVideoPerformance,
} from "@/lib/kernel/video"
import type {
  GenerateVideoScriptInput,
  GenerateVideoScriptOutput,
  UpdateVideoGenerationSettingsInput,
  UpdateVideoGenerationSettingsOutput,
  SubmitVideoGenerationJobInput,
  SubmitVideoGenerationJobOutput,
  LoadVideoGenerationStateInput,
  LoadVideoGenerationStateOutput,
  PreviewVideoProjectInput,
  PreviewVideoProjectOutput,
  DistributeVideoProjectInput,
  DistributeVideoProjectOutput,
  RepurposeVideoOutputInput,
  RepurposeVideoOutputOutput,
  LoadVideoPerformanceInput,
  LoadVideoPerformanceOutput,
} from "@/lib/kernel/video"

/**
 * THIS MODULE IS THE ONE IMPLEMENTATION of the video generation lane.
 *
 * Every export here is a "use server" function, which means it is an HTTP
 * endpoint the browser can call by name with arguments of its choosing. The
 * kernel commands they delegate to (lib/kernel/video.ts) take a projectId and
 * read/write ai_video_projects with NO tenant check of their own, so the tenant
 * check has to happen HERE, before the delegation, or any signed-in user can
 * name any project id.
 *
 * RLS is not a substitute. ai_video_projects has RLS enabled, but every policy
 * reads `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`
 * and brokerage_id is NULLABLE — so any project row created without a tenant is
 * readable AND writable by every authenticated user in the system. The gate
 * below closes that hole because it compares the project's brokerage_id to the
 * caller's for equality, which a NULL can never satisfy.
 *
 * app/api/video/projects/[projectId]/{script,generate,preview,publish} are the
 * SECOND DOOR onto these same functions — they parse HTTP and delegate here.
 * They do not re-implement the gate.
 *
 * ── NOT ORPHANS. DO NOT RETIRE THEM. (wave 14) ──────────────────────────────
 * A route census keeps re-flagging those four as "duplicates whose survivor is
 * app/actions/video.ts", because their headers say "HTTP door onto
 * app/actions/video.ts". A thin door is not a duplicate — it is the merged
 * RESULT of an earlier consolidation, and two things depend on it existing:
 *   · scripts/video-generation-lane-simulator.ts (npm run test:video-generation-lane,
 *     inside `npm run guard`) reads all four files by path and asserts each one
 *     imports from @/app/actions/video, holds no second tenant check, and calls
 *     no kernel command directly. Delete a file and `code(rel)` returns "" —
 *     every assertion about it fails, and so does the guard.
 *   · ../video-action-http.ts states the doors were kept so "any external
 *     consumer sees no change" in status codes. Nothing in this repo can prove
 *     no such consumer exists. UNRESOLVED, and unresolved means leave it.
 * The same holds for app/api/video/projects/route.ts, which
 * scripts/video-project-consolidation-simulator.ts reads by path.
 */

/** Why a call was refused. Maps to an HTTP status at the route door. */
export type VideoActionDenialCode =
  | "invalid_project_id"
  | "unauthenticated"
  | "no_brokerage"
  | "project_not_found"
  | "forbidden"
  | "failed"

interface TenantDenial {
  code: VideoActionDenialCode
  message: string
}

export type VideoActionResult<T> =
  | { success: true; data: T; error?: undefined; code?: undefined }
  | { success: false; data?: undefined; error: string; code: VideoActionDenialCode }

function denied<T>(d: TenantDenial): VideoActionResult<T> {
  return { success: false, error: d.message, code: d.code }
}

function failed<T>(err: unknown, fallback: string): VideoActionResult<T> {
  return {
    success: false,
    error: err instanceof Error ? err.message : fallback,
    code: "failed",
  }
}

/**
 * The caller's own brokerage, resolved from the session — never from an
 * argument. Split out of the project gate so the gate stays short enough to
 * read in one screen.
 */
async function callerBrokerage(): Promise<{ brokerage_id: string } | TenantDenial> {
  const supabase = await createServerClient()
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError) return { code: "unauthenticated", message: authError.message }
  if (!auth?.user) return { code: "unauthenticated", message: "Not authenticated" }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", auth.user.id)
    .maybeSingle()
  if (profileError) return { code: "failed", message: profileError.message }
  if (!profile?.brokerage_id) {
    return { code: "no_brokerage", message: "Your account is not linked to a brokerage yet" }
  }
  return { brokerage_id: profile.brokerage_id as string }
}

/**
 * THE GATE. A video project belongs to the caller's brokerage, or this refuses.
 * Mirrors the `authorize` gate in app/api/video/projects/[projectId]/generate.
 *
 * Returns null when the caller may proceed, and a denial otherwise. A project
 * in another brokerage is reported as "not found" on this door so the action
 * cannot be used to enumerate project ids across tenants; the route door still
 * answers 403 for it, preserving the HTTP contract it already had.
 */
async function assertProjectInCallerBrokerage(projectId: string): Promise<TenantDenial | null> {
  if (!isValidUUID(projectId)) return { code: "invalid_project_id", message: "Invalid video project id" }
  const profile = await callerBrokerage()
  if ("code" in profile) return profile
  const svc = (await import("@/lib/supabase/service")).createServiceClient()
  const { data: project, error } = await svc
    .from("ai_video_projects").select("brokerage_id").eq("id", projectId).maybeSingle()
  if (error) return { code: "failed", message: error.message }
  if (!project) return { code: "project_not_found", message: "Video project not found" }
  if (project.brokerage_id !== profile.brokerage_id) {
    return { code: "forbidden", message: "Video project not found" }
  }
  return null
}

/**
 * createVideoProjectAction was REMOVED — collapsed into
 * app/actions/video/create-video-project.ts:createVideoProject.
 *
 * It was a thin wrapper over lib/kernel/video.ts:createVideoProject, which
 * inserts into ai_video_projects directly and writes `input.agentId` straight
 * into the agents-class ai_video_projects.agent_id (FK agents(id) since m366)
 * without resolving it. It was left unwired for that reason, and left UNDELETED
 * for a different one: the kernel path was the only creator carrying campaign
 * attribution, so deleting it would have lost a capability rather than a copy.
 *
 * That capability has since been MOVED, not dropped. The survivor now takes
 * campaignId / sourceType / sourceId / description and writes
 * marketing_campaign_id (a real column) plus source_type / source_id /
 * description into the video_metadata jsonb, exactly as the kernel path did —
 * and additionally resolves users->agents, tenant-checks the campaign, and
 * emits VIDEO_GENERATION_REQUESTED, none of which the kernel path did. Its
 * scriptless 'setup' lane is carried too, via `scriptPending`.
 * app/api/video/projects/route.ts POST — the only live caller — now calls the
 * survivor. With nothing left that the wrapper did more completely, it is gone.
 */

/**
 * Write the AI script onto an existing project and move it to 'scripting'.
 * Tenant anchor: input.projectId → ai_video_projects.brokerage_id.
 */
export async function generateVideoScriptAction(
  input: GenerateVideoScriptInput
): Promise<VideoActionResult<GenerateVideoScriptOutput>> {
  const denial = await assertProjectInCallerBrokerage(input.projectId)
  if (denial) return denied(denial)
  try {
    const data = await generateVideoScript(input)
    return { success: true, data }
  } catch (err) {
    return failed(err, "Failed to generate script")
  }
}

/**
 * Voice / avatar / music / subtitle / watermark settings for a project.
 * Tenant anchor: input.projectId → ai_video_projects.brokerage_id.
 */
export async function updateVideoGenerationSettingsAction(
  input: UpdateVideoGenerationSettingsInput
): Promise<VideoActionResult<UpdateVideoGenerationSettingsOutput>> {
  const denial = await assertProjectInCallerBrokerage(input.projectId)
  if (denial) return denied(denial)
  try {
    const data = await updateVideoGenerationSettings(input)
    return { success: true, data }
  } catch (err) {
    return failed(err, "Failed to update settings")
  }
}

/**
 * Submit the render to the platform vendor (D-ID). Spends money and claims the
 * project's generation slot, so the gate matters most here.
 * Tenant anchor: input.projectId → ai_video_projects.brokerage_id.
 */
export async function submitVideoGenerationJobAction(
  input: SubmitVideoGenerationJobInput
): Promise<VideoActionResult<SubmitVideoGenerationJobOutput>> {
  const denial = await assertProjectInCallerBrokerage(input.projectId)
  if (denial) return denied(denial)
  try {
    const data = await submitVideoGenerationJob(input)
    return { success: true, data }
  } catch (err) {
    return failed(err, "Failed to submit job")
  }
}

/**
 * The project's live generation state — status, script, settings, video url.
 * Tenant anchor: input.projectId → ai_video_projects.brokerage_id.
 */
export async function loadVideoGenerationStateAction(
  input: LoadVideoGenerationStateInput
): Promise<VideoActionResult<LoadVideoGenerationStateOutput>> {
  const denial = await assertProjectInCallerBrokerage(input.projectId)
  if (denial) return denied(denial)
  try {
    const data = await loadVideoGenerationState(input)
    return { success: true, data }
  } catch (err) {
    return failed(err, "Failed to load state")
  }
}

/**
 * The rendered stream url for playback.
 * Tenant anchor: input.projectId → ai_video_projects.brokerage_id.
 */
export async function previewVideoProjectAction(
  input: PreviewVideoProjectInput
): Promise<VideoActionResult<PreviewVideoProjectOutput>> {
  const denial = await assertProjectInCallerBrokerage(input.projectId)
  if (denial) return denied(denial)
  try {
    const data = await previewVideoProject(input)
    return { success: true, data }
  } catch (err) {
    return failed(err, "Failed to load preview")
  }
}

/**
 * Queue the rendered video onto the agent's connected social accounts.
 * Tenant anchor: input.projectId → ai_video_projects.brokerage_id.
 */
export async function distributeVideoProjectAction(
  input: DistributeVideoProjectInput
): Promise<VideoActionResult<DistributeVideoProjectOutput>> {
  const denial = await assertProjectInCallerBrokerage(input.projectId)
  if (denial) return denied(denial)
  try {
    const data = await distributeVideoProject(input)
    return { success: true, data }
  } catch (err) {
    return failed(err, "Failed to distribute")
  }
}

/**
 * Derivative cuts of a finished render (shorts / clips / thumbnail).
 * Tenant anchor: input.projectId → ai_video_projects.brokerage_id.
 */
export async function repurposeVideoOutputAction(
  input: RepurposeVideoOutputInput
): Promise<VideoActionResult<RepurposeVideoOutputOutput>> {
  const denial = await assertProjectInCallerBrokerage(input.projectId)
  if (denial) return denied(denial)
  try {
    const data = await repurposeVideoOutput(input)
    return { success: true, data }
  } catch (err) {
    return failed(err, "Failed to repurpose")
  }
}

/**
 * Real distribution numbers for a rendered video project — views / engagement /
 * comments / shares aggregated from the social posts whose media_urls contain
 * this project's video_url. There is no API route for this, so this action is
 * the only path to it; the numbers were being computed for nobody.
 * Tenant anchor: input.projectId → ai_video_projects.brokerage_id.
 */
export async function loadVideoPerformanceAction(
  input: LoadVideoPerformanceInput
): Promise<VideoActionResult<LoadVideoPerformanceOutput>> {
  const denial = await assertProjectInCallerBrokerage(input.projectId)
  if (denial) return denied(denial)
  try {
    const data = await loadVideoPerformance(input)
    return { success: true, data }
  } catch (err) {
    return failed(err, "Failed to load performance")
  }
}
