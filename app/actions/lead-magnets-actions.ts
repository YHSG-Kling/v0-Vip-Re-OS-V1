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
  description?: string
  thank_you_message?: string
  tcpa_text?: string
  notify_on_submission?: boolean
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.agentId) return { success: false as const, error: "Not authenticated" }
    const result = await createLeadMagnet({
      title: input.name,
      magnetType: input.magnet_type as any,
      brokerageId: ctx.brokerageId,
      agentId: ctx.agentId,
      createdBy: ctx.agentId,
      description: input.description ?? "",
      thankYouMessage: input.thank_you_message,
      tcpaDisclosureText: input.tcpa_text,
    })
    // Persist the notification preference. There is NO `settings` column (the old write silently
    // errored AND failed the whole create) — stash it in the landing_content jsonb bag (the public page
    // ignores unknown keys). Non-fatal: the magnet exists regardless of whether the preference persists.
    if (result.success && result.magnetId && input.notify_on_submission !== undefined) {
      const supabase = createServiceClient()
      const { error: notifyError } = await supabase
        .from("lead_capture_forms")
        .update({ landing_content: { notify_on_submission: input.notify_on_submission } })
        .eq("id", result.magnetId)
      if (notifyError) console.warn("[lead-magnets] notify preference not saved:", notifyError.message)
    }
    return result
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to create magnet" }
  }
}

/**
 * Persist the AI-generated landing copy + GEO FAQ + JSON-LD onto a lead magnet so the public
 * /lm/[slug] page can render it for AI-search visibility. Brokerage-scoped (a user can only write
 * to their own brokerage's magnet). Marketing copy only — separate from the kernel-owned portal view.
 */
export async function saveMagnetLandingContentAction(
  magnetId: string,
  landing: import("@/lib/marketing/lead-magnet-copy").LandingContent,
) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    const supabase = createServiceClient()
    const { error } = await supabase
      .from("lead_capture_forms")
      .update({ landing_content: landing })
      .eq("id", magnetId)
      .eq("brokerage_id", ctx.brokerageId)
    if (error) return { success: false as const, error: error.message }
    return { success: true as const }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to save landing content" }
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
    // Map known setting keys to REAL lead_capture_forms columns — there is no `settings` column, so the
    // old `{ settings }` write silently errored (every settings update failed). isActive may arrive as
    // the 3rd arg OR inside the settings bag (the MagnetLibrary toggle passes { isActive }).
    const s = (settings ?? {}) as Record<string, unknown>
    const updatePayload: Record<string, unknown> = {}
    if (typeof s.name === "string") updatePayload.name = s.name
    if (typeof s.thankYouMessage === "string") updatePayload.thank_you_message = s.thankYouMessage
    if (typeof s.redirectUrl === "string") updatePayload.redirect_url = s.redirectUrl
    if (typeof s.tcpaDisclosureText === "string") updatePayload.tcpa_disclosure_text = s.tcpaDisclosureText
    const active = isActive !== undefined ? isActive : (typeof s.isActive === "boolean" ? s.isActive : undefined)
    if (active !== undefined) updatePayload.is_active = active
    if (Object.keys(updatePayload).length === 0) return { success: false as const, error: "No recognized settings to update" }
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

// Re-exports are illegal in "use server" files — wrap instead.
import { captureFormSubmissionAction as _captureFormSubmission } from "./lead-magnet-capture"
export async function captureFormSubmissionAction(...args: Parameters<typeof _captureFormSubmission>) {
  return _captureFormSubmission(...args)
}
