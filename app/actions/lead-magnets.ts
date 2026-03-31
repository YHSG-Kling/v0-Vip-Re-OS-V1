
"use server"

import {
  createLeadMagnet,
  publishLeadMagnet,
  captureFormSubmission,
  generateQRCode,
  trackMagnetEvent,
  getMagnetPerformance,
  updateMagnetSettings,
  listLeadMagnets,
  type CreateLeadMagnetInput,
  type CreateLeadMagnetOutput,
  type PublishLeadMagnetInput,
  type PublishLeadMagnetOutput,
  type CaptureFormSubmissionInput,
  type CaptureFormSubmissionOutput,
  type GenerateQRCodeInput,
  type GenerateQRCodeOutput,
  type GetMagnetPerformanceInput,
  type GetMagnetPerformanceOutput,
  type UpdateMagnetSettingsInput,
  type UpdateMagnetSettingsOutput,
  type ListLeadMagnetsInput,
  type ListLeadMagnetsOutput,
} from "@/lib/kernel/lead-magnets"
import { createClient } from "@/lib/supabase/server"
import { headers } from "next/headers"

// ── Kernel Command 1: createLeadMagnetAction ──────────────────────────────────
// Input:  CreateLeadMagnetInput
// Output: CreateLeadMagnetOutput
// Validation: auth required, brokerageId FK match
export async function createLeadMagnetAction(
  input: CreateLeadMagnetInput
): Promise<CreateLeadMagnetOutput> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { success: false, error: "Unauthorized" }

    if (!input.title?.trim()) return { success: false, error: "Title is required" }
    if (!input.brokerageId) return { success: false, error: "brokerageId is required" }
    if (!input.agentId) return { success: false, error: "agentId is required" }

    return await createLeadMagnet({ ...input, createdBy: user.id })
  } catch (err) {
    console.error("[lead-magnets] createLeadMagnetAction:", err)
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ── Kernel Command 2: publishLeadMagnetAction ─────────────────────────────────
// Input:  PublishLeadMagnetInput
// Output: PublishLeadMagnetOutput
export async function publishLeadMagnetAction(
  input: PublishLeadMagnetInput
): Promise<PublishLeadMagnetOutput> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { success: false, error: "Unauthorized" }

    if (!input.magnetId) return { success: false, error: "magnetId is required" }
    if (!input.channels?.length) return { success: false, error: "At least one channel required" }

    const headersList = await headers()
    const host = headersList.get("host") ?? "localhost:3000"
    const proto = host.startsWith("localhost") ? "http" : "https"
    const baseUrl = input.baseUrl || `${proto}://${host}`

    return await publishLeadMagnet({ ...input, actorUserId: user.id, baseUrl })
  } catch (err) {
    console.error("[lead-magnets] publishLeadMagnetAction:", err)
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ── Kernel Command 3: captureFormSubmissionAction ─────────────────────────────
// Input:  CaptureFormSubmissionInput
// Output: CaptureFormSubmissionOutput
// No auth required — public-facing form submissions
export async function captureFormSubmissionAction(
  input: CaptureFormSubmissionInput
): Promise<CaptureFormSubmissionOutput> {
  try {
    if (!input.formId) return { success: false, error: "formId is required" }
    if (!input.brokerageId) return { success: false, error: "brokerageId is required" }
    if (!input.submissionData) return { success: false, error: "submissionData is required" }

    const headersList = await headers()
    const ipAddress = headersList.get("x-forwarded-for")?.split(",")[0] ?? headersList.get("x-real-ip") ?? undefined
    const userAgent = headersList.get("user-agent") ?? undefined

    return await captureFormSubmission({ ...input, ipAddress, userAgent })
  } catch (err) {
    console.error("[lead-magnets] captureFormSubmissionAction:", err)
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ── Kernel Command 4: generateQRCodeAction ────────────────────────────────────
// Input:  GenerateQRCodeInput
// Output: GenerateQRCodeOutput
export async function generateQRCodeAction(
  input: GenerateQRCodeInput
): Promise<GenerateQRCodeOutput> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { success: false, error: "Unauthorized" }

    if (!input.magnetId) return { success: false, error: "magnetId is required" }
    if (!input.targetUrl) return { success: false, error: "targetUrl is required" }

    return await generateQRCode(input)
  } catch (err) {
    console.error("[lead-magnets] generateQRCodeAction:", err)
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ── Kernel Command 6: getMagnetPerformanceAction ──────────────────────────────
// Input:  GetMagnetPerformanceInput
// Output: GetMagnetPerformanceOutput
export async function getMagnetPerformanceAction(
  input: GetMagnetPerformanceInput
): Promise<GetMagnetPerformanceOutput> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { success: false, error: "Unauthorized" }

    if (!input.magnetId) return { success: false, error: "magnetId is required" }
    if (!input.brokerageId) return { success: false, error: "brokerageId is required" }

    return await getMagnetPerformance(input)
  } catch (err) {
    console.error("[lead-magnets] getMagnetPerformanceAction:", err)
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ── Kernel Command 7: updateMagnetSettingsAction ──────────────────────────────
// Input:  UpdateMagnetSettingsInput
// Output: UpdateMagnetSettingsOutput
export async function updateMagnetSettingsAction(
  input: UpdateMagnetSettingsInput
): Promise<UpdateMagnetSettingsOutput> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { success: false, error: "Unauthorized" }

    if (!input.magnetId) return { success: false, error: "magnetId is required" }
    if (!input.updates || !Object.keys(input.updates).length) return { success: false, error: "No updates provided" }

    return await updateMagnetSettings({ ...input, actorUserId: user.id })
  } catch (err) {
    console.error("[lead-magnets] updateMagnetSettingsAction:", err)
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ── Kernel Command 8: listLeadMagnetsAction ───────────────────────────────────
// Input:  ListLeadMagnetsInput
// Output: ListLeadMagnetsOutput
export async function listLeadMagnetsAction(
  input: ListLeadMagnetsInput
): Promise<ListLeadMagnetsOutput> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { success: false, error: "Unauthorized" }

    if (!input.brokerageId) return { success: false, error: "brokerageId is required" }

    return await listLeadMagnets(input)
  } catch (err) {
    console.error("[lead-magnets] listLeadMagnetsAction:", err)
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}
