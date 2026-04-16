"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { listLeadMagnets, createLeadMagnet, publishLeadMagnet } from "@/lib/kernel/lead-magnets"

export async function listLeadMagnetsAction(options?: { brokerageId?: string; agentId?: string }) {
  try {
    const ctx = await getAgentContext()
    const bId = ctx.brokerageId
    if (!bId) return { success: false as const, error: "Not authenticated" }
    return listLeadMagnets({ brokerageId: bId, agentId: options?.agentId })
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to list magnets" }
  }
}

export async function createLeadMagnetAction(input: {
  name: string
  magnet_type: string
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.agentId) return { success: false as const, error: "Not authenticated" }
    return createLeadMagnet({
      title: input.name,
      magnetType: input.magnet_type as any,
      brokerageId: ctx.brokerageId,
      agentId: ctx.agentId,
      createdBy: ctx.agentId,
      description: "",
    })
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to create magnet" }
  }
}

// Delegates to kernel publishLeadMagnet which reads/writes lead_capture_forms
export async function publishLeadMagnetAction(magnetId: string) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.agentId) return { success: false as const, error: "Not authenticated" }
    return publishLeadMagnet({
      magnetId,
      brokerageId: ctx.brokerageId,
      channels: ["landing_page"],
      actorUserId: ctx.agentId,
      baseUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
    })
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to publish" }
  }
}

// Writes to lead_capture_forms (canonical table used by kernel)
export async function updateMagnetSettingsAction(magnetId: string, settings: Record<string, unknown>, isActive?: boolean) {
  try {
    const supabase = createServiceClient()
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    const updatePayload: Record<string, unknown> = { settings }
    if (isActive !== undefined) updatePayload.is_active = isActive
    const { error } = await supabase
      .from("lead_capture_forms")
      .update(updatePayload)
      .eq("id", magnetId)
      .eq("brokerage_id", ctx.brokerageId)
    if (error) return { success: false as const, error: error.message }
    return { success: true as const }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to update settings" }
  }
}

export async function getMagnetPerformanceAction(magnetId: string) {
  try {
    const supabase = createServiceClient()
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    // Verify the form belongs to this brokerage before reading submissions
    const { data: form } = await supabase
      .from("lead_capture_forms")
      .select("id")
      .eq("id", magnetId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    if (!form) return { success: false as const, error: "Magnet not found" }
    const { data, error } = await supabase
      .from("form_submissions")
      .select("*")
      .eq("form_id", magnetId)
    if (error) return { success: false as const, error: error.message }
    return { success: true as const, submissions: data ?? [], total: data?.length ?? 0 }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to get performance" }
  }
}

export async function generateQRCodeAction(input: { magnetId: string; url: string }) {
  try {
    const supabase = createServiceClient()
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    // Verify the form belongs to this brokerage before creating a QR code for it
    const { data: form } = await supabase
      .from("lead_capture_forms")
      .select("id")
      .eq("id", input.magnetId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    if (!form) return { success: false as const, error: "Magnet not found" }
    const { data, error } = await supabase
      .from("qr_codes")
      .insert({
        magnet_id: input.magnetId,
        target_url: input.url,
        brokerage_id: ctx.brokerageId,
      })
      .select("id, qr_image_url")
      .single()
    if (error) return { success: false as const, error: error.message }
    return { success: true as const, qrCode: data }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to generate QR" }
  }
}

// Re-export from lead-magnet-capture for convenience
export { captureFormSubmissionAction } from "./lead-magnet-capture"
