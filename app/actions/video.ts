"use server"

import { createServerClient } from "@/lib/supabase/server"
import {
  createVideoProject,
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
  CreateVideoProjectInput,
  CreateVideoProjectOutput,
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
 * The caller's brokerage, and a check that a video project belongs to it.
 * Mirrors the `authorize` gate in app/api/video/projects/[projectId]/generate.
 *
 * The kernel video functions take a projectId and read ai_video_projects with no
 * tenant check of their own, so a server action reached from a browser must do
 * the check before delegating — otherwise any signed-in user can name any
 * project id.
 */
async function assertProjectInCallerBrokerage(projectId: string): Promise<string | null> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return "Not authenticated"

  const { data: profile, error: profileError } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (profileError) return profileError.message
  if (!profile?.brokerage_id) return "Your account is not linked to a brokerage yet"

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { data: project, error } = await svc
    .from("ai_video_projects").select("brokerage_id").eq("id", projectId).maybeSingle()
  if (error) return error.message
  if (!project) return "Video project not found"
  if (project.brokerage_id !== profile.brokerage_id) return "Video project not found"
  return null
}

/**
 * NOT WIRED, DELIBERATELY — do not connect this to a surface.
 *
 * lib/kernel/video.ts:createVideoProject INSERTS into ai_video_projects
 * directly and writes `input.agentId` straight into the agents-class
 * ai_video_projects.agent_id without resolving it, so this wrapper would let a
 * browser name the owning agent. The settled owner ruling is that video
 * projects are created through app/actions/video/create-video-project.ts:
 * createVideoProject, which resolves the agents id via resolveAgentIdInBrokerage,
 * resolves the provider (D-ID default) and emits VIDEO_GENERATION_REQUESTED.
 *
 * It is left in place rather than deleted because that survivor does NOT carry
 * everything this path does — it has no marketing_campaign_id / source_type /
 * source_id linkage — so removing this would lose the campaign-attributed
 * creation lane that app/api/video/projects/route.ts POST still serves. Closing
 * that gap is a kernel change, not a wiring change.
 */
export async function createVideoProjectAction(
  input: CreateVideoProjectInput
): Promise<{ success: boolean; data?: CreateVideoProjectOutput; error?: string }> {
  try {
    const data = await createVideoProject(input)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to create project" }
  }
}

export async function generateVideoScriptAction(
  input: GenerateVideoScriptInput
): Promise<{ success: boolean; data?: GenerateVideoScriptOutput; error?: string }> {
  try {
    const data = await generateVideoScript(input)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to generate script" }
  }
}

export async function updateVideoGenerationSettingsAction(
  input: UpdateVideoGenerationSettingsInput
): Promise<{ success: boolean; data?: UpdateVideoGenerationSettingsOutput; error?: string }> {
  try {
    const data = await updateVideoGenerationSettings(input)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to update settings" }
  }
}

export async function submitVideoGenerationJobAction(
  input: SubmitVideoGenerationJobInput
): Promise<{ success: boolean; data?: SubmitVideoGenerationJobOutput; error?: string }> {
  try {
    const data = await submitVideoGenerationJob(input)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to submit job" }
  }
}

export async function loadVideoGenerationStateAction(
  input: LoadVideoGenerationStateInput
): Promise<{ success: boolean; data?: LoadVideoGenerationStateOutput; error?: string }> {
  try {
    const data = await loadVideoGenerationState(input)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to load state" }
  }
}

export async function previewVideoProjectAction(
  input: PreviewVideoProjectInput
): Promise<{ success: boolean; data?: PreviewVideoProjectOutput; error?: string }> {
  try {
    const data = await previewVideoProject(input)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to load preview" }
  }
}

export async function distributeVideoProjectAction(
  input: DistributeVideoProjectInput
): Promise<{ success: boolean; data?: DistributeVideoProjectOutput; error?: string }> {
  try {
    const data = await distributeVideoProject(input)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to distribute" }
  }
}

export async function repurposeVideoOutputAction(
  input: RepurposeVideoOutputInput
): Promise<{ success: boolean; data?: RepurposeVideoOutputOutput; error?: string }> {
  try {
    const data = await repurposeVideoOutput(input)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to repurpose" }
  }
}

/**
 * Real distribution numbers for a rendered video project — views / engagement /
 * comments / shares aggregated from the social posts whose media_urls contain
 * this project's video_url. There is no API route for this, so this action is
 * the only path to it; the numbers were being computed for nobody.
 */
export async function loadVideoPerformanceAction(
  input: LoadVideoPerformanceInput
): Promise<{ success: boolean; data?: LoadVideoPerformanceOutput; error?: string }> {
  const denied = await assertProjectInCallerBrokerage(input.projectId)
  if (denied) return { success: false, error: denied }
  try {
    const data = await loadVideoPerformance(input)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to load performance" }
  }
}
