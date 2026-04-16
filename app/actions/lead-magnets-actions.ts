"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { listLeadMagnets } from "@/lib/kernel/lead-magnets"

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
  slug?: string
  settings?: Record<string, unknown>
}) {
  try {
    const supabase = createServiceClient()
    const ctx = await getAgentContext()
    const { data, error } = await supabase
      .from("lead_magnets")
      .insert({
        ...input,
        brokerage_id: ctx.brokerageId,
        agent_user_id: ctx.agentId,
        status: "draft",
      })
      .select("id")
      .single()
    if (error) return { success: false as const, error: error.message }
    return { success: true as const, magnet: data }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to create magnet" }
  }
}

export async function publishLeadMagnetAction(magnetId: string) {
  try {
    const supabase = createServiceClient()
    const ctx = await getAgentContext()
    const { error } = await supabase
      .from("lead_magnets")
      .update({ status: "published", published_at: new Date().toISOString() })
      .eq("id", magnetId)
      .eq("brokerage_id", ctx.brokerageId)
    if (error) return { success: false as const, error: error.message }
    return { success: true as const }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to publish" }
  }
}

export async function updateMagnetSettingsAction(magnetId: string, settings: Record<string, unknown>) {
  try {
    const supabase = createServiceClient()
    const ctx = await getAgentContext()
    const { error } = await supabase
      .from("lead_magnets")
      .update({ settings })
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
    // Verify the magnet belongs to this brokerage before reading submissions
    const { data: magnet } = await supabase
      .from("lead_magnets")
      .select("id")
      .eq("id", magnetId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    if (!magnet) return { success: false as const, error: "Magnet not found" }
    const { data, error } = await supabase
      .from("lead_magnet_submissions")
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
    // Verify the magnet belongs to this brokerage before creating a QR code for it
    const { data: magnet } = await supabase
      .from("lead_magnets")
      .select("id")
      .eq("id", input.magnetId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    if (!magnet) return { success: false as const, error: "Magnet not found" }
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
