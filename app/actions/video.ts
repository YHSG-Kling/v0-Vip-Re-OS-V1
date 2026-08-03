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

export async function loadVideoPerformanceAction(
  input: LoadVideoPerformanceInput
): Promise<{ success: boolean; data?: LoadVideoPerformanceOutput; error?: string }> {
  try {
    const data = await loadVideoPerformance(input)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to load performance" }
  }
}
