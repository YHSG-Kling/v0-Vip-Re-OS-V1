"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { listLeadMagnets, createLeadMagnet, publishLeadMagnet } from "@/lib/kernel/lead-magnets"

/** Roles whose Lead Magnets view is the whole brokerage rather than just their own.
 *  TRUE ADMIN GATE (operational: marketing — the owner ruling's team_lead-included
 *  tier) — repointed to the ONE tenant roster via isAdminOrBroker below.
 *  'superadmin' was dead: 0 live rows store that users.user_type. Mirrored by
 *  BROKERAGE_WIDE_ROLES in app/dashboard/marketing/lead-magnets/page.tsx. */
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

/**
 * Scope is resolved HERE, from the session — never from a client-supplied id.
 *
 * It used to take `agentId` from the caller, and every caller passed the AUTH
 * USER id. lead_capture_forms.agent_id is a FK to agents(id), not users(id), so
 * the filter matched nothing and the library rendered "0 lead magnets" for
 * every user in the product. Resolving from getAgentContext() (whose .agentId
 * IS agents.id) both fixes it and removes the parameter that made the mistake
 * possible — a client cannot ask to see another agent's magnets.
 *
 * Broker/admin/superadmin get the brokerage-wide list; everyone else gets their
 * own. Fail-closed: a session with no agents row sees nothing rather than the
 * unfiltered brokerage.
 */
export async function listLeadMagnetsAction(options?: { scope?: "mine" | "brokerage" }) {
  try {
    const ctx = await getAgentContext()
    const bId = ctx.brokerageId
    if (!bId) return { success: false as const, error: "Not authenticated" }

    const wantsBrokerageWide =
      options?.scope !== "mine" && isAdminOrBroker({ user_type: ctx.role })

    if (wantsBrokerageWide) {
      return listLeadMagnets({ brokerageId: bId })
    }
    if (!ctx.agentId) {
      return { success: false as const, error: "No agent profile for this user — complete onboarding to use lead magnets." }
    }
    return listLeadMagnets({ brokerageId: bId, agentId: ctx.agentId })
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
    // Persist the notification preference into the dedicated `settings` jsonb bag
    // (added in l40-s01) — NOT landing_content, which the AI-landing-copy save
    // overwrites. Non-fatal: the magnet exists regardless of whether it persists.
    if (result.success && result.magnetId && input.notify_on_submission !== undefined) {
      const supabase = createServiceClient()
      const { error: notifyError } = await supabase
        .from("lead_capture_forms")
        .update({ settings: { notify_on_submission: input.notify_on_submission } })
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
    const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (typeof s.name === "string") updatePayload.name = s.name
    if (typeof s.thankYouMessage === "string") updatePayload.thank_you_message = s.thankYouMessage
    if (typeof s.redirectUrl === "string") updatePayload.redirect_url = s.redirectUrl
    if (typeof s.tcpaDisclosureText === "string") updatePayload.tcpa_disclosure_text = s.tcpaDisclosureText
    // Merged from the deleted kernel command updateMagnetSettings (lib/kernel/lead-magnets.ts):
    // the capture-form FIELD LIST is a legitimate setting too.
    if (Array.isArray(s.fields)) updatePayload.fields = s.fields
    const active = isActive !== undefined ? isActive : (typeof s.isActive === "boolean" ? s.isActive : undefined)
    if (active !== undefined) updatePayload.is_active = active
    if (Object.keys(updatePayload).length === 1) return { success: false as const, error: "No recognized settings to update" }
    const { error } = await supabase
      .from("lead_capture_forms")
      .update(updatePayload)
      .eq("id", magnetId)
      .eq("brokerage_id", ctx.brokerageId)
    if (error) return { success: false as const, error: error.message }
    // Audit trail (merged from the kernel command): who changed which settings.
    // Best-effort — the settings write above already succeeded.
    const { error: auditError } = await supabase.from("lifecycle_events").insert({
      entity_type: "lead_capture_form",
      entity_id: magnetId,
      event_type: "lead_magnet_updated",
      actor_user_id: ctx.userId ?? null,
      brokerage_id: ctx.brokerageId,
      metadata: { updatedFields: Object.keys(updatePayload).filter((k) => k !== "updated_at") },
    })
    if (auditError) console.warn("[lead-magnets] settings updated but audit event refused:", auditError.message)
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

/**
 * generateQRCodeAction — the session gate in front of the ONE lead-magnet QR minter.
 *
 * MERGED-THEN-DELETED: this action's own `qr_codes` insert is gone. It was the third of three
 * lead-magnet minters, each with a different dedupe key — this one had NO dedupe at all and a
 * random slug, so every click of "Generate Tracked QR Code" minted another code and the magnet's
 * scans split across them. The write now goes through lib/kernel/lead-magnets.ts:generateQRCode →
 * lib/marketing/tracked-qr.ts:mintTrackedQr, deduped on `lead_magnet:<magnetId>`.
 *
 * WHAT THIS PATH CONTRIBUTED AND KEPT (merged onto the survivor before it died):
 *   • purpose 'lead_magnet' — every reader of a lead-magnet QR filters on it; writing "general"
 *     meant a freshly generated QR was never found again (the tab kept offering "Generate", the
 *     library never showed a scan count).
 *   • destination_type 'landing_page' — neither of the other two set it.
 *   • the agents.id stamp: qr_codes.agent_id FKs agents(id); ctx.agentId is that PK, and a users
 *     id in that column is a refused insert.
 *
 * It also now returns the rendered PNG so the UI stops fetching it from api.qrserver.com.
 */
export async function generateQRCodeAction(input: { magnetId: string; url: string }) {
  try {
    const supabase = createServiceClient()
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    // Verify the form belongs to this brokerage before creating a QR code for it.
    // GATE-THEN-SERVICE: the minter writes with the service client, so this check is the only gate.
    const { data: form, error: formError } = await supabase
      .from("lead_capture_forms")
      .select("id")
      .eq("id", input.magnetId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    if (formError) return { success: false as const, error: formError.message }
    if (!form) return { success: false as const, error: "Magnet not found" }

    const { generateQRCode } = await import("@/lib/kernel/lead-magnets")
    const result = await generateQRCode({
      magnetId: input.magnetId,
      brokerageId: ctx.brokerageId,
      agentId: ctx.agentId ?? null,
      label: `Lead Magnet QR: ${input.magnetId}`,
      targetUrl: input.url,
    })
    if (!result.success) return { success: false as const, error: result.error ?? "Failed to generate QR" }

    return {
      success: true as const,
      qrCode: {
        id: result.qrCodeId!,
        slug: result.slug!,
        target_url: result.targetUrl!,
        scan_url: result.scanUrl!,
        image_url: result.qrImageUrl!,
      },
    }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to generate QR" }
  }
}

// Re-exports are illegal in "use server" files — wrap instead.
import { captureFormSubmissionAction as _captureFormSubmission } from "./lead-magnet-capture"
export async function captureFormSubmissionAction(...args: Parameters<typeof _captureFormSubmission>) {
  return _captureFormSubmission(...args)
}
